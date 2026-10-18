import { spawn } from 'node:child_process'
import { mkdir, mkdtemp, readdir, readFile, rm, stat, symlink, utimes, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join, resolve } from 'node:path'
import { Writable } from 'node:stream'
import pino from 'pino'
import { afterEach, describe, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { pruneLogFiles } from '../src/infrastructure/logger.js'

const api = resolve(import.meta.dirname, '..')
const temps: string[] = []
async function temporaryDirectory(prefix: string): Promise<string> {
  const root = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(root, { recursive: true })
  const directory = await mkdtemp(join(root, prefix))
  temps.push(directory)
  return directory
}
afterEach(async () => { await Promise.all(temps.splice(0).map((dir) => rm(dir, { recursive: true, force: true }))) })

/** Runs a real Node process against the real logger modules, as the API process would. */
async function run(source: string, env: NodeJS.ProcessEnv = {}, signal?: NodeJS.Signals) {
  const dir = await temporaryDirectory('api-log-script-')
  const script = join(dir, 'main.mts')
  await writeFile(script, source)
  return new Promise<{ code: number | null; lines: Record<string, unknown>[]; stderr: string }>((done, fail) => {
    // Without VITEST the child logs like the real API process.
    const parent = Object.fromEntries(Object.entries(process.env).filter(([key]) => key !== 'VITEST'))
    const child = spawn(process.execPath, ['--import', 'tsx', script], {
      cwd: api, env: { ...parent, LOG_LEVEL: 'info', ...env }, stdio: ['ignore', 'pipe', 'pipe'],
    })
    let out = '', stderr = '', signalled = false
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk })
    child.stdout.on('data', (chunk: Buffer) => {
      out += chunk
      if (signal && !signalled && out.includes('"ready"')) { signalled = true; child.kill(signal) }
    })
    child.on('error', fail)
    child.on('close', (code) => done({ code, stderr, lines: out.split('\n').filter((line) => line.startsWith('{')).map((line) => JSON.parse(line) as Record<string, unknown>) }))
  })
}
const imports = `import { componentLogger, enableFileLogging } from '${join(api, 'src/infrastructure/logger.ts')}'
import { installProcessLifecycleLogging } from '${join(api, 'src/infrastructure/processLifecycle.ts')}'
const log = componentLogger('lifecycle'); installProcessLifecycleLogging(log)`

describe('API logging', () => {
  it('writes structured JSON with component, level and redacted secrets', async () => {
    const { code, lines } = await run(`${imports}
      componentLogger('http').info({ req: { headers: { authorization: 'Bearer s3cret' } }, token: 'tok', run: { prompt: 'private words' } }, 'hello')`)
    expect(code).toBe(0)
    const hello = lines.find((line) => line.msg === 'hello')!
    expect(hello).toMatchObject({ level: 'info', service: 'graphql-api', component: 'http', token: '[redacted]', run: { prompt: '[redacted]' } })
    expect(JSON.stringify(lines)).not.toMatch(/s3cret|private words|"tok"/)
    expect(lines.at(-1)).toMatchObject({ msg: 'process exiting', exitCode: 0 })
  })

  it.each([
    ['uncaught exception', `setTimeout(() => { throw new Error('boom') })`],
    ['unhandled rejection', `Promise.reject(new Error('boom'))`],
  ])('logs a fatal line before an %s ends the process', async (kind, crash) => {
    const { code, lines } = await run(`${imports}\n${crash}`)
    expect(code).toBe(1)
    const fatal = lines.find((line) => line.level === 'fatal')!
    expect(fatal).toMatchObject({ msg: kind, component: 'lifecycle', err: { message: 'boom' } })
    expect(lines.at(-1)).toMatchObject({ level: 'error', msg: 'process exiting', exitCode: 1 })
  })

  it('logs a shutdown signal and still lets the owner handle it', async () => {
    const { code, lines } = await run(`${imports}
      process.once('SIGTERM', () => { log.info('stopped'); process.exit(0) })
      log.info('ready'); setInterval(() => {}, 1000)`, {}, 'SIGTERM')
    expect(code).toBe(0)
    expect(lines.map((line) => line.msg)).toEqual(['ready', 'shutdown signal received', 'stopped', 'process exiting'])
  })

  it('also writes to a rotating file under LOG_DIR, including the fatal line', async () => {
    const dir = await temporaryDirectory('api-logs-')
    const { code } = await run(`${imports}\nawait enableFileLogging(process.env)\nthrow new Error('file boom')`, { LOG_DIR: dir })
    expect(code).toBe(1)
    const files = (await readdir(dir)).filter((name) => /^api\.(?:\d{4}-\d{2}-\d{2}\.)?\d+\.log$/.test(name))
    expect(files).toHaveLength(1)
    const written = await readFile(join(dir, files[0]!), 'utf8')
    expect(written).toContain('"msg":"file logging enabled"')
    expect(written).toContain('"level":"fatal"')
    expect(written).toContain('file boom')
    expect(written).toContain('"msg":"process exiting"')
  })
})

describe('log retention and noise', () => {
  it('retains newer rotations when an older rotation is modified last', async () => {
    const dir = await temporaryDirectory('api-log-order-')
    const now = Date.now()
    const names = ['api.2000-01-01.1.log', 'api.2000-01-01.2.log', 'api.2000-01-01.3.log']
    for (const [index, name] of names.entries()) await writeFile(join(dir, name), `record ${index + 1}`)
    await utimes(join(dir, names[0]!), now / 1000, (now + 2000) / 1000)
    await utimes(join(dir, names[1]!), now / 1000, now / 1000)
    await utimes(join(dir, names[2]!), now / 1000, (now + 1000) / 1000)
    await symlink(names[2]!, join(dir, 'current.log'))

    expect(await pruneLogFiles(join(dir, 'api.log'), 2, 14, now + 3000)).toEqual([names[0]])
    expect(await readFile(join(dir, names[1]!), 'utf8')).toBe('record 2')
    expect(await readFile(join(dir, names[2]!), 'utf8')).toBe('record 3')
  })

  it('waits for older segment writes to close before pruning rotated files', async () => {
    const dir = await temporaryDirectory('api-log-drain-')
    const { code, lines, stderr } = await run(`
      import fs from 'node:fs'
      import { readdir, readFile } from 'node:fs/promises'
      import { join } from 'node:path'
      import { rotatingLogDestination } from '${join(api, 'src/modules/diagnostics/rotatingLogDestination.ts')}'
      import { pruneLogFiles } from '${join(api, 'src/infrastructure/logger.ts')}'
      const file = join(process.env.LOG_DIR, 'api.log')
      const destination = await rotatingLogDestination(file, '1b', () => {})
      let cleanup = Promise.resolve()
      destination.on('ready', () => { cleanup = cleanup.then(() => pruneLogFiles(file, 2, 14)) })
      const written = Object.fromEntries(['A', 'B', 'C'].map(record => [record, Promise.withResolvers()]))
      const closed = Promise.withResolvers()
      const write = fs.write
      const close = fs.close
      let heldFd
      let release
      fs.write = function (...args) {
        const text = String(args[1])
        const record = ['A', 'B', 'C'].find(record => text.includes('"record":"' + record + '"'))
        if (record) {
          const callback = args.pop()
          args.push((...result) => {
            callback(...result)
            written[record].resolve()
          })
        }
        if (record === 'A') {
          heldFd = args[0]
          release = () => Reflect.apply(write, fs, args)
          return
        }
        return Reflect.apply(write, fs, args)
      }
      fs.close = function (fd, callback) {
        return close(fd, (...result) => {
          callback(...result)
          if (fd === heldFd) closed.resolve()
        })
      }
      let beforeDrain
      try {
        for (const record of ['A', 'B', 'C']) destination.write(JSON.stringify({ record }) + String.fromCharCode(10))
        await Promise.all([written.B.promise, written.C.promise])
        await cleanup
        beforeDrain = (await readdir(process.env.LOG_DIR)).filter(name => name.startsWith('api.') && name.endsWith('.log')).length
      } finally {
        fs.write = write
        release()
      }
      await closed.promise
      fs.close = close
      await cleanup
      await pruneLogFiles(file, 2, 14)
      const names = (await readdir(process.env.LOG_DIR)).filter(name => name.startsWith('api.') && name.endsWith('.log'))
      const records = await Promise.all(names.map(async name => JSON.parse(await readFile(join(process.env.LOG_DIR, name), 'utf8')).record))
      console.log(JSON.stringify({ beforeDrain, records: records.sort() }))
    `, { LOG_DIR: dir })
    expect(code, stderr).toBe(0)
    expect(lines).toEqual([{ beforeDrain: 3, records: ['B', 'C'] }])
  })

  it.each(['burst', 'delayed writes', 'exit flush'])(
    'allows only the final record to cross the file size threshold during %s', async mode => {
      const dir = await temporaryDirectory('api-log-queued-')
      const { code, lines } = await run(`${imports}
        import fs from 'node:fs'
        import { flushLogsSync } from '${join(api, 'src/infrastructure/logger.ts')}'
        await enableFileLogging(process.env)
        ${mode === 'delayed writes' ? `
          const write = fs.write
          fs.write = function (...args) {
            if (args[0] !== 1) {
              const callback = args.pop()
              args.push((...result) => setImmediate(() => callback(...result)))
            }
            return Reflect.apply(write, fs, args)
          }` : ''}
        for (let record = 0; record < 40; record++) {
          log.info({ record, detail: '界'.repeat(240) }, 'queued record')
        }
        ${mode === 'exit flush' ? 'flushLogsSync(); process.exit(0)' : ''}`, {
        LOG_DIR: dir, LOG_MAX_SIZE: '4k', LOG_MAX_FILES: '100',
      })
      expect(code).toBe(0)
      const names = (await readdir(dir)).filter(name => /^api\..*\.log$/.test(name))
      expect(names.length).toBeGreaterThan(1)
      const records: Record<string, unknown>[] = []
      for (const name of names) {
        const content = await readFile(join(dir, name), 'utf8')
        const written = content.trimEnd().split('\n')
        // All bytes before the final whole record must be below the threshold.
        const lastRecordBytes = Buffer.byteLength(written.at(-1)! + '\n')
        expect(Buffer.byteLength(content) - lastRecordBytes, name).toBeLessThan(4096)
        records.push(...written.map(line => JSON.parse(line) as Record<string, unknown>))
      }
      const queued = records.filter(line => line.msg === 'queued record')
        .sort((a, b) => Number(a.record) - Number(b.record))
      expect(queued).toEqual(lines.filter(line => line.msg === 'queued record'))
      expect(queued.map(line => line.record)).toEqual(Array.from({ length: 40 }, (_, record) => record))
      expect(records.filter(line => line.msg === 'process exiting')).toHaveLength(1)
    },
  )

  it('starts a dated destination instead of appending to reused oversized numbered logs', async () => {
    const dir = await temporaryDirectory('api-log-restart-')
    const existing = 'previous log data\n'.repeat(1024)
    await writeFile(join(dir, 'api.1.log'), existing)
    await writeFile(join(dir, 'api.2.log'), existing)
    const { code } = await run(`${imports}
      await enableFileLogging(process.env)
      log.info('after restart')`, { LOG_DIR: dir, LOG_MAX_SIZE: '4k' })
    expect(code).toBe(0)
    expect(await readFile(join(dir, 'api.1.log'), 'utf8')).toBe(existing)
    expect(await readFile(join(dir, 'api.2.log'), 'utf8')).toBe(existing)
    const logs = await Promise.all((await readdir(dir))
      .filter(name => /^api\..*\.log$/.test(name))
      .map(name => readFile(join(dir, name), 'utf8')))
    expect(logs.some(content => content.includes('"msg":"after restart"'))).toBe(true)
  })

  it('bounds file sizes and total retention across restarts and size rolls', async () => {
    const dir = await temporaryDirectory('api-log-bounds-')
    await writeFile(join(dir, 'other.1.log'), 'unrelated')
    for (let restart = 0; restart < 6; restart++) {
      const { code } = await run(`${imports}
        await enableFileLogging(process.env)
        for (let record = 0; record < 10; record++) {
          log.info({ detail: 'x'.repeat(700) }, 'bounded record')
          await new Promise(resolve => setTimeout(resolve, 20))
        }
        await new Promise(resolve => setTimeout(resolve, 100))`, {
        LOG_DIR: dir, LOG_MAX_SIZE: '4k', LOG_MAX_FILES: '3',
      })
      expect(code).toBe(0)
      const names = (await readdir(dir)).filter(name => /^api\..*\.log$/.test(name))
      expect(names.length).toBeGreaterThan(0)
      expect(names.length).toBeLessThanOrEqual(3)
      for (const name of names) {
        // Rotation follows a write, so one record may cross the threshold.
        expect((await stat(join(dir, name))).size).toBeLessThanOrEqual(4096 + 1024)
      }
      const logs = await Promise.all(names.map(name => readFile(join(dir, name), 'utf8')))
      expect(logs.some(content => content.includes('"msg":"bounded record"'))).toBe(true)
    }
    expect(await readFile(join(dir, 'other.1.log'), 'utf8')).toBe('unrelated')
  })

  it('counts legacy and dated logs together at startup, including a single retained file', async () => {
    const dir = await temporaryDirectory('api-log-retention-')
    for (const name of ['api.1.log', 'api.2.log', 'api.2000-01-01.1.log']) {
      await writeFile(join(dir, name), 'old log')
    }
    await writeFile(join(dir, 'other.1.log'), 'unrelated')
    const { code } = await run(`${imports}
      await enableFileLogging(process.env)
      log.info('retained active record')
      await new Promise(resolve => setTimeout(resolve, 100))`, { LOG_DIR: dir, LOG_MAX_FILES: '1' })
    expect(code).toBe(0)
    const names = (await readdir(dir)).filter(name => /^api\..*\.log$/.test(name))
    expect(names).toHaveLength(1)
    expect(await readFile(join(dir, names[0]!), 'utf8')).toContain('"msg":"retained active record"')
    expect(await readFile(join(dir, 'other.1.log'), 'utf8')).toBe('unrelated')
  })

  it('preserves the active destination even when its age exceeds retention', async () => {
    const dir = await temporaryDirectory('api-log-active-')
    const now = Date.now()
    await writeFile(join(dir, 'api.2000-01-01.1.log'), 'active')
    await writeFile(join(dir, 'api.1.log'), 'inactive')
    await utimes(join(dir, 'api.2000-01-01.1.log'), 0, 0)
    await symlink('api.2000-01-01.1.log', join(dir, 'current.log'))
    await pruneLogFiles(join(dir, 'api.log'), 1, 14, now)
    expect(await readFile(join(dir, 'current.log'), 'utf8')).toBe('active')
    expect((await readdir(dir)).filter(name => /^api\..*\.log$/.test(name))).toHaveLength(1)
  })

  it('prunes only its own rotated files, by age and then by count', async () => {
    const dir = await temporaryDirectory('api-prune-')
    const now = Date.now(), day = 86_400_000
    const files = { 'api.1.log': 20, 'api.2.log': 3, 'api.3.log': 2, 'api.4.log': 1, 'api.5.log': 0, 'other.1.log': 40, 'api.log.bak': 40 }
    for (const [name, age] of Object.entries(files)) {
      await writeFile(join(dir, name), 'x')
      await utimes(join(dir, name), (now - age * day) / 1000, (now - age * day) / 1000)
    }
    const removed = await pruneLogFiles(join(dir, 'api.log'), 3, 14, now)
    expect(removed.sort()).toEqual(['api.1.log', 'api.2.log'])
    expect((await readdir(dir)).sort()).toEqual(['api.3.log', 'api.4.log', 'api.5.log', 'api.log.bak', 'other.1.log'])
  })

  it('keeps routine requests at debug and surfaces failures, without query strings', async () => {
    const lines: Record<string, unknown>[] = []
    const sink = new Writable({ write(chunk, _encoding, done) { lines.push(JSON.parse(String(chunk)) as Record<string, unknown>); done() } })
    const app = buildApp({ logger: pino({ level: 'debug' }, sink), readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } } })
    app.get('/boom', async () => { throw new Error('boom') })
    try {
      await app.inject({ method: 'GET', url: '/health/live?token=abc' })
      await app.inject({ method: 'GET', url: '/missing' })
      await app.inject({ method: 'GET', url: '/boom' })
    } finally { await app.close() }
    const completed = lines.filter((line) => line.msg === 'request completed')
    expect(completed.map((line) => [line.level, line.path, line.statusCode])).toEqual([
      [20, '/health/live', 200], [30, '/missing', 404], [50, '/boom', 500]])
    // The 500 keeps its error and stack (the app's error handler) with Fastify's own request lines off.
    expect(lines.find((line) => line.msg === 'The API could not complete the request.')).toMatchObject({ level: 50, err: { message: 'boom' } })
    expect(JSON.stringify(lines)).not.toContain('token=abc')
    expect(lines.some((line) => line.msg === 'incoming request')).toBe(false)
  })
})

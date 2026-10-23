import { mkdtemp, mkdir, rm, writeFile } from 'node:fs/promises'
import { request } from 'node:http'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { Writable } from 'node:stream'
import pino from 'pino'
import { afterEach, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import { registerBuiltWeb } from '../src/builtWeb.js'

const cleanup: (() => Promise<unknown>)[] = []
afterEach(async () => {
  for (const close of cleanup.splice(0).reverse()) await close()
})

function get(address: string, path: string): Promise<{ statusCode: number | undefined; body: string }> {
  return new Promise((resolve, reject) => {
    // Pass the raw request target separately so URL parsing cannot normalize it.
    const outgoing = request(address, { path, agent: false }, response => {
      let body = ''
      response.setEncoding('utf8')
      response.on('data', chunk => { body += chunk })
      response.on('error', reject)
      response.on('end', () => resolve({ statusCode: response.statusCode, body }))
    })
    outgoing.on('error', reject)
    outgoing.end()
  })
}

it('rejects non-canonical static paths as client errors without logging server failures', async () => {
  const temporaryRoot = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(temporaryRoot, { recursive: true })
  const root = await mkdtemp(join(temporaryRoot, 'built-web-paths-'))
  cleanup.push(() => rm(root, { recursive: true, force: true }))
  await mkdir(join(root, 'assets'))
  await writeFile(join(root, 'index.html'), '<!doctype html><title>Foreman Code</title>')
  await writeFile(join(root, 'assets/app.js'), 'console.log("compiled")')
  const lines: Record<string, unknown>[] = []
  const sink = new Writable({ write(chunk, _encoding, done) {
    lines.push(JSON.parse(String(chunk)) as Record<string, unknown>)
    done()
  } })
  cleanup.push(async () => { sink.destroy() })
  const app = buildApp({ logger: pino({ level: 'debug' }, sink), readiness: {
    database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined },
  } })
  cleanup.push(() => app.close())
  await registerBuiltWeb(app, root)
  const address = await app.listen({ host: '127.0.0.1', port: 0 })

  for (const path of ['/assets/../index.html', '/assets//app.js', '/assets/./app.js']) {
    const response = await get(address, path)
    expect(response.statusCode, path).toBe(403)
    expect(JSON.parse(response.body)).toMatchObject({ error: { code: 'FORBIDDEN' } })
  }
  expect(lines.filter(line => Number(line.level) >= 50)).toEqual([])
  expect((await get(address, '/assets/app.js')).statusCode).toBe(200)
})

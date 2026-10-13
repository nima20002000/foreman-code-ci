import { randomUUID } from 'node:crypto'
import { existsSync } from 'node:fs'
import { mkdir, mkdtemp, rm, symlink } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { expect, it, vi } from 'vitest'
import { HostCiRunner, systemHostCiPorts, type HostCiPorts } from '../src/modules/ci-host/runner.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'

it('measures consecutive part setup using real dependencies on the CI executor', async () => {
  const base = process.env.FOREMAN_CODE_TEST_ROOT ?? process.env.TMPDIR
  if (!base) throw new Error('A disposable test root is required')
  const root = await mkdtemp(join(base, 'slot-measurement-'))
  const system = systemHostCiPorts()
  const environment: NodeJS.ProcessEnv = { ...gitFixtureEnvironment(), BASH_ENV: '' }
  const origin = join(root, 'origin')
  const processes = new Set<Promise<unknown>>()
  const command = async (args: string[], cwd?: string) => {
    const result = await system.run('git', args, { ...(cwd ? { cwd } : {}), env: environment })
    if (result.code !== 0) throw new Error(result.stderr)
    return result.stdout.trim()
  }
  try {
    const source = await command(['rev-parse', '--show-toplevel'])
    const cache = join(root, 'runner/cache/example/project')
    await mkdir(cache, { recursive: true })
    const hostCache = dirname(resolve(source, environment.FOREMAN_CODE_CI_CONTRACTS_CACHE ?? '.logs/contracts'))
    const cloudStore = join(source, 'node_modules/.pnpm-store')
    const seed = existsSync(cloudStore)
      ? { store: cloudStore, metadata: join(source, '.logs/pnpm-metadata') }
      : { store: join(hostCache, 'pnpm-store'), metadata: join(hostCache, 'pnpm-metadata') }
    for (const [from, to] of [[seed.store, 'pnpm-store'], [seed.metadata, 'pnpm-metadata']] as const) {
      if (!existsSync(from)) throw new Error(`CI offline cache unavailable: ${to}`)
      await symlink(from, join(cache, to))
    }
    await command(['clone', '--quiet', '--no-hardlinks', source, origin])
    console.log('[ci-slot-setup] offline seed ready')
    const commit = await command(['rev-parse', 'HEAD'], origin)
    const ports: HostCiPorts = { ...system, cpus: 8, memoryBytes: 16 * 2 ** 30,
      availableMemoryBytes: () => 16 * 2 ** 30,
      run: async (file, args, options) => {
        if (file === 'gh') return { code: 0, stdout: '', stderr: '' }
        if (file === 'git' && (args.includes('clone') || args.includes('remote'))) {
          return system.run(file, args.map(value => value.startsWith('https://') ? origin : value), options)
        }
        if (file === 'systemd-run') {
          const cwd = args.find(value => value.startsWith('--working-directory='))!.split('=').slice(1).join('=')
          const completion = system.run('bash', [args.at(-1)!], { cwd, env: environment, timeoutMs: 180_000 })
          processes.add(completion)
          void completion.finally(() => processes.delete(completion))
          return { code: 0, stdout: '', stderr: '' }
        }
        if (file === 'systemctl') return { code: 0, stdout: processes.size ? 'active' : 'inactive', stderr: '' }
        return system.run(file, args, options)
      } }
    const runner = new HostCiRunner(join(root, 'runner'), ports, environment)
    const run = async () => {
      const suite = 'lint'
      const runId = randomUUID()
      console.log(`[ci-slot-setup] starting ${suite}`)
      let offset = 0
      let text = ''
      await runner.handle({ operation: 'start', runId, repository: 'example/project', commit, suite,
        ...(suite === 'lint' ? { scope: 'affected', files: ['apps/api/src/modules/ci-host/warmSetup.ts'] } : {}) })
      const reply = await vi.waitFor(async () => {
        const reply = await runner.handle({ operation: 'read', runId, afterOffset: offset, maxBytes: 65_536 })
        if (reply.operation !== 'read') throw new Error('Unexpected reply')
        if (reply.nextOffset > offset) {
          text += reply.text
          console.log(`[ci-slot-setup] ${reply.text.slice(-2000)}`)
          offset = reply.nextOffset
        }
        if (['starting', 'running'].includes(reply.run.state)) throw new Error('Runner is still active')
        return reply
      }, { timeout: 180_000, interval: 100 })
      expect(reply.run.state, `${reply.run.message ?? ''}\n${reply.text}`).toBe('passed')
      return text
    }
    const first = await run()
    const repeat = await run()
    const setup = (text: string) => {
      const match = /\[ci-setup\] setup completed in (\d+) ms/.exec(text)
      if (!match) throw new Error('Runner did not report setup time')
      return Number(match[1]) / 1000
    }
    console.log(`[ci-slot-measurement] first=${setup(first)}s repeat=${setup(repeat)}s; same executor and commit`)
  } finally {
    await Promise.all(processes)
    await rm(root, { recursive: true, force: true })
  }
}, 240_000)

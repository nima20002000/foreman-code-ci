import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { CI_HOST_CACHE_BUDGET_BYTES } from './cacheCleanup.js'
import { HostCiRunner, type HostCiPorts } from './runner.js'
import { withHostCiRunLock } from './runnerLock.js'

async function fixture(state: 'stopped' | 'active' | 'unknown' | 'timed-out' = 'stopped') {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const root = await mkdtemp(join(parent, 'ci-cache-ownership-'))
  const repositories = ['fixture/first', 'fixture/second']
  const slots: string[] = []
  const queries: { units: string[]; timeoutMs: number | undefined }[] = []
  const entered = deferred()
  const release = deferred()
  let now = new Date('2026-10-17T00:00:00Z')
  const ports: HostCiPorts = { now: () => now, cpus: 8, memoryBytes: 16 * 2 ** 30,
    run: async (file, args, options) => {
      if (file === 'systemctl' && args.includes('show')) {
        const units = args.filter(arg => arg.endsWith('.service'))
        queries.push({ units, timeoutMs: options?.timeoutMs })
        entered.resolve()
        await release.promise
        return { code: state === 'unknown' ? 1 : 0, stderr: '', timedOut: state === 'timed-out',
          stdout: units.map(unit => `Id=${unit}\nLoadState=loaded\nActiveState=${state === 'active' ? 'active' : 'inactive'}\n`)
            .join('\n') }
      }
      return { code: 0, stdout: '', stderr: '' }
    } }
  const runner = new HostCiRunner(root, ports, {})
  try {
    for (const repository of repositories) {
      const clone = join(root, 'git', repository)
      const slot = join(root, 'slots', repository, '0')
      slots.push(slot)
      await mkdir(join(clone, '.git/objects'), { recursive: true })
      await mkdir(join(root, 'cache', repository), { recursive: true })
      await mkdir(join(slot, 'src'), { recursive: true })
      await writeFile(join(slot, 'src/package'), 'installed bytes')
      const file = await open(join(clone, '.git/objects/pack'), 'wx')
      try { await file.truncate(CI_HOST_CACHE_BUDGET_BYTES + 1) } finally { await file.close() }
    }
    const runIds = Array.from({ length: 3 }, () => randomUUID())
    for (const runId of runIds) {
      await expect(runner.cancel(runId)).resolves.toMatchObject({ runId, state: 'canceled' })
    }
    return { root, runner, repositories, slots, queries, runIds, entered, release,
      advance: () => { now = new Date(now.getTime() + 60 * 60_000) },
      close: async () => {
        release.resolve()
        await runner.beginDrain()
        await rm(root, { recursive: true, force: true })
      } }
  } catch (error) {
    release.resolve()
    await runner.beginDrain()
    await rm(root, { recursive: true, force: true })
    throw error
  }
}

it('queries metadata-less cancellation owners in one batch across all repository candidates', async () => {
  const f = await fixture()
  try {
    f.release.resolve()
    await f.runner.status()
    await f.runner.beginDrain()
    expect(f.queries).toHaveLength(1)
    expect(f.queries[0]!.units.toSorted()).toEqual(f.runIds.map(id => `foreman-ci-${id}.service`).toSorted())
    for (const slot of f.slots) await expect(access(slot)).rejects.toMatchObject({ code: 'ENOENT' })
  } finally { await f.close() }
})

it('keeps cache and clone locks available to foreground work while native ownership is queried', async () => {
  const f = await fixture()
  try {
    await f.runner.status()
    await f.entered.promise
    const available: (boolean | undefined)[] = []
    for (const repository of f.repositories) {
      for (const area of ['cache', 'git']) {
        available.push(await withHostCiRunLock(join(f.root, area, repository), async () => true,
          { nonBlocking: true }))
      }
    }
    f.release.resolve()
    await f.runner.beginDrain()
    expect(available).toEqual([true, true, true, true])
  } finally { await f.close() }
})

it('gives cleanup native-state queries a short explicit timeout', async () => {
  const f = await fixture()
  try {
    f.release.resolve()
    await f.runner.status()
    await f.runner.beginDrain()
    expect(f.queries[0]!.timeoutMs).toBeGreaterThan(0)
    expect(f.queries[0]!.timeoutMs).toBeLessThanOrEqual(2_000)
  } finally { await f.close() }
})

it.each(['active', 'unknown', 'timed-out'] as const)(
  'preserves repository storage when the batched native state is %s', async state => {
    const f = await fixture(state)
    try {
      f.release.resolve()
      await f.runner.status()
      await f.runner.beginDrain()
      expect(f.queries).toHaveLength(1)
      for (const slot of f.slots) expect(await readFile(join(slot, 'src/package'), 'utf8')).toBe('installed bytes')
    } finally { await f.close() }
  },
)

it.each(['metadata', 'cancellation'] as const)(
  'rechecks a changed %s owner after the native batch and retries on the next scheduled sweep', async change => {
    const f = await fixture()
    try {
      await f.runner.status()
      await f.entered.promise
      if (change === 'metadata') await writeFile(join(f.root, 'runs', f.runIds[0]!, 'meta.json'), 'null')
      else await f.runner.cancel(randomUUID())
      f.release.resolve()
      await f.runner.beginDrain()
      for (const slot of f.slots) expect(await readFile(join(slot, 'src/package'), 'utf8')).toBe('installed bytes')
      f.advance()
      await f.runner.status()
      await f.runner.beginDrain()
      for (const slot of f.slots) await expect(access(slot)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.close() }
  },
)

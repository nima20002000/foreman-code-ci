import { randomUUID } from 'node:crypto'
import { access, mkdir, mkdtemp, open, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { HostCiRunner } from './runner.js'
import { CI_HOST_CACHE_BUDGET_BYTES } from './cacheCleanup.js'

it('reports healthy runs when other retained run directories are incomplete or damaged', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'ci-damaged-'))
  const meta = (runId: string, exitCode: number | null) => JSON.stringify({ runId, repository: 'example/project',
    commit: 'a'.repeat(40), suite: 'lint', state: 'passed', startedAt: '2026-10-13T00:00:00Z',
    finishedAt: '2026-10-13T00:01:00Z', exitCode, message: null, cleaned: true })
  try {
    const [healthy, noLog, noMeta] = [randomUUID(), randomUUID(), randomUUID()]
    for (const runId of [healthy, noLog, noMeta]) await mkdir(join(root, 'runs', runId), { recursive: true })
    await writeFile(join(root, 'runs', healthy, 'meta.json'), meta(healthy, 0))
    await writeFile(join(root, 'runs', healthy, 'log'), '')
    await writeFile(join(root, 'runs', noLog, 'meta.json'), meta(noLog, 0))
    const runner = new HostCiRunner(root, { now: () => new Date(), cpus: 8, memoryBytes: 16 * 2 ** 30,
      availableMemoryBytes: () => 16 * 2 ** 30, run: async () => ({ code: 0, stdout: '', stderr: '' }) })
    const status = await runner.handle({ operation: 'status' })
    if (status.operation !== 'status') throw new Error('Expected CI status')
    expect(status.runs.map(run => run.runId)).toEqual([healthy])
    expect(status.slotsTotal).toBeGreaterThan(0)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it('keeps a live run with an unreadable log counted and listed instead of treating it as absent', async () => {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(cache, { recursive: true })
  const root = await mkdtemp(join(cache, 'ci-live-damaged-'))
  try {
    const runId = randomUUID()
    await mkdir(join(root, 'runs', runId), { recursive: true })
    await writeFile(join(root, 'runs', runId, 'meta.json'), JSON.stringify({ runId, repository: 'example/project',
      commit: 'a'.repeat(40), suite: 'lint', state: 'running', startedAt: '2026-10-13T00:00:00Z',
      finishedAt: null, exitCode: null, message: null, cleaned: false, slot: 0, serviceUnit: 'live.service' }))
    // The step record exists but the log is gone, so reading the run fails while its unit is still active.
    await writeFile(join(root, 'runs', runId, 'step'), 'lint')
    const runner = new HostCiRunner(root, { now: () => new Date(), cpus: 8, memoryBytes: 16 * 2 ** 30,
      availableMemoryBytes: () => 16 * 2 ** 30,
      run: async (file, args) => ({ code: 0, stderr: '',
        stdout: file === 'systemctl' && args.includes('show') ? 'Id=live.service\nLoadState=loaded\nActiveState=active\n' : '' }) })
    const status = await runner.handle({ operation: 'status' })
    if (status.operation !== 'status') throw new Error('Expected CI status')
    expect(status.runs.map(run => [run.runId, run.state])).toEqual([[runId, 'running']])
    expect(status.slotsUsed).toBe(1)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

it.each(['stopped', 'active', 'unknown'] as const)(
  'reconciles a damaged storage owner through native status %s before automatic reclamation', async state => {
    const parent = join(homedir(), '.cache', 'foreman-tmp')
    await mkdir(parent, { recursive: true })
    const root = await mkdtemp(join(parent, 'ci-damaged-storage-'))
    const runId = randomUUID()
    const run = join(root, 'runs', runId)
    const clone = join(root, 'git/fixture/site')
    const slot = join(root, 'slots/fixture/site/0')
    await mkdir(run, { recursive: true })
    await mkdir(join(clone, '.git/objects'), { recursive: true })
    await mkdir(join(slot, 'src/node_modules'), { recursive: true })
    await writeFile(join(run, 'meta.json'), 'null')
    await writeFile(join(slot, 'src/node_modules/package'), 'installed bytes')
    const pack = await open(join(clone, '.git/objects/pack'), 'wx')
    try { await pack.truncate(CI_HOST_CACHE_BUDGET_BYTES + 1) } finally { await pack.close() }
    const runner = new HostCiRunner(root, { now: () => new Date(), cpus: 8, memoryBytes: 16 * 2 ** 30,
      run: async (file, args) => {
        if (file === 'systemctl' && args.includes('show')) {
          return { code: state === 'unknown' ? 1 : 0, stderr: '',
            stdout: `Id=foreman-ci-${runId}.service\nLoadState=loaded\nActiveState=${state === 'stopped' ? 'inactive' : 'active'}\n` }
        }
        return { code: 0, stdout: '', stderr: '' }
      } })
    try {
      await expect(runner.handle({ operation: 'status' })).resolves.toMatchObject({ operation: 'status', runs: [] })
      await runner.beginDrain()
      if (state === 'stopped') {
        await expect(access(slot)).rejects.toMatchObject({ code: 'ENOENT' })
        await expect(access(join(clone, '.git'))).rejects.toMatchObject({ code: 'ENOENT' })
      } else {
        expect(await readFile(join(slot, 'src/node_modules/package'), 'utf8')).toBe('installed bytes')
      }
      expect(await readFile(join(run, 'meta.json'), 'utf8')).toBe('null')
    } finally {
      await runner.beginDrain()
      await rm(root, { recursive: true, force: true })
    }
  },
)

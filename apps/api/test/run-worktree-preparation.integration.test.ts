import { execFileSync } from 'node:child_process'
import { access, mkdir, readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { AcceptedWorkflowRunV3Schema, RunWorktreeSchema } from '@foreman-code/contracts/wave25'
import { RunWorktrees } from '../src/modules/runs/runWorktrees.js'
import { systemGitWorktreePorts } from '../src/modules/sources/gitWorktree.js'
import { agent3Database, postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'
import { gitFixtureEnvironment } from './helpers/gitFixture.js'

async function fixture() {
  const db = await agent3Database()
  const env = gitFixtureEnvironment()
  const git = (cwd: string, ...args: string[]) => execFileSync('git', args, { cwd, env, encoding: 'utf8' }).trim()
  try {
    const seeded = await seedAgent3(db.pool, db.directory)
    git(db.directory, 'init', '-b', 'main')
    await mkdir(join(db.directory, 'apps', 'api'), { recursive: true })
    await writeFile(join(db.directory, 'project.txt'), 'project\n')
    await writeFile(join(db.directory, 'apps', 'api', 'service.txt'), 'service\n')
    git(db.directory, 'add', 'project.txt', 'apps')
    git(db.directory, 'commit', '-m', 'Project')
    const run = AcceptedWorkflowRunV3Schema.parse(seeded.run)
    const ports = systemGitWorktreePorts(env)
    const managed = join(db.directory, 'managed')
    return { db, run, ports, managed, git, service: new RunWorktrees(db.pool, managed, ports),
      async stop() {
        const record = { ...run, executionState: 'interrupted' }
        await db.pool.query('update runs set execution_state=$2,record=$3::jsonb where id=$1',
          [run.id, record.executionState, JSON.stringify(record)])
      },
      async trees() {
        const rows = await db.pool.query<{ record: unknown }>('select record from run_worktrees where run_id=$1', [run.id])
        return rows.rows.map(row => RunWorktreeSchema.parse(row.record))
      },
    }
  } catch (error) {
    await db.close()
    throw error
  }
}

describe.runIf(postgresEnabled)('Local execution worktree preparation', () => {
  it('isolates concurrent writable executions in the same Run and recovers each allocation', async () => {
    const f = await fixture()
    try {
      const signal = AbortSignal.timeout(30_000)
      const [first, second] = await Promise.all([
        f.service.prepare(f.run, signal, 'writer-one'),
        f.service.prepare(f.run, signal, 'writer-two'),
      ])
      expect(first).toBeDefined()
      expect(second).toBeDefined()
      expect(second!.workingDirectory).not.toBe(first!.workingDirectory)
      expect(second!.branch).not.toBe(first!.branch)
      await writeFile(join(first!.workingDirectory, 'project.txt'), 'first writer\n')
      expect(await readFile(join(second!.workingDirectory, 'project.txt'), 'utf8')).toBe('project\n')
      const recovered = new RunWorktrees(f.db.pool, f.managed, f.ports)
      expect(await recovered.prepare(f.run, signal, 'writer-one')).toEqual(first)
      expect(await recovered.prepare(f.run, signal, 'writer-two')).toEqual(second)
      expect(await f.trees()).toEqual(expect.arrayContaining([first, second]))
      expect(await f.trees()).toHaveLength(2)
    } finally { await f.db.close() }
  })

  it('leaves pool clients available while Git and duplicate preparations wait', async () => {
    const f = await fixture()
    let release!: () => void
    let entered!: () => void
    const blocked = new Promise<void>(resolve => { release = resolve })
    const started = new Promise<void>(resolve => { entered = resolve })
    const ports = { ...f.ports, git: async (...args: Parameters<typeof f.ports.git>) => {
      if (args[0][0] === 'worktree' && args[0][1] === 'add') {
        entered()
        await blocked
      }
      return f.ports.git(...args)
    } }
    const service = new RunWorktrees(f.db.pool, f.managed, ports)
    const pending = Array.from({ length: 12 }, () => service.prepare(f.run))
    try {
      await started
      expect(f.db.pool.totalCount - f.db.pool.idleCount).toBe(0)
      expect(f.db.pool.waitingCount).toBe(0)
      expect((await f.db.pool.query('select 1 as available')).rows).toEqual([{ available: 1 }])
    } finally {
      release()
      const results = await Promise.allSettled(pending)
      await f.db.close()
      for (const result of results) {
        if (result.status === 'rejected') throw result.reason
      }
    }
  })

  it('refuses an unfinished listed checkout after restart and preserves its files', async () => {
    const f = await fixture()
    let allocated!: string
    const ports = { ...f.ports, git: async (...args: Parameters<typeof f.ports.git>) => {
      if (args[0][0] === 'worktree' && args[0][1] === 'add') {
        const result = await f.ports.git([...args[0], '--no-checkout'], args[1])
        expect(result.code).toBe(0)
        allocated = args[0][args[0].length - 2]!
        await writeFile(join(allocated, 'keep.txt'), 'partial preparation\n')
        throw new Error('Checkout interrupted')
      }
      return f.ports.git(...args)
    } }
    try {
      await expect(new RunWorktrees(f.db.pool, f.managed, ports).prepare(f.run)).rejects.toThrow('Checkout interrupted')
      await expect(f.service.prepare(f.run)).rejects.toMatchObject({ code: 'RUN_WORKTREE_UNAVAILABLE' })
      expect(await readFile(join(allocated, 'keep.txt'), 'utf8')).toBe('partial preparation\n')
      expect(await f.trees()).toEqual([expect.objectContaining({ state: 'retained' })])
    } finally { await f.db.close() }
  })

  it('keeps the selected repository subfolder as the execution working directory', async () => {
    const f = await fixture()
    try {
      const selected = { ...f.run, executionLocation: {
        ...f.run.executionLocation, rootPath: join(f.db.directory, 'apps', 'api'),
      } }
      const tree = await f.service.prepare(selected)
      expect(tree).toBeDefined()
      const checkout = f.git(tree!.workingDirectory, 'rev-parse', '--show-toplevel')
      expect(tree!.workingDirectory).toBe(join(checkout, 'apps', 'api'))
      expect(await readFile(join(tree!.workingDirectory, 'service.txt'), 'utf8')).toBe('service\n')
      await f.stop()
      const errors: unknown[] = []
      await f.service.cleanup(error => errors.push(error))
      expect(errors).toEqual([])
      await expect(access(checkout)).rejects.toMatchObject({ code: 'ENOENT' })
    } finally { await f.db.close() }
  })

  it('retries retained worktrees with backoff and removes them only after their edits are committed', async () => {
    const f = await fixture()
    try {
      const tree = (await f.service.prepare(f.run))!
      await writeFile(join(tree.workingDirectory, 'keep.txt'), 'retained edit\n')
      await f.stop()
      let inspections = 0
      const ports = { ...f.ports, git: async (...args: Parameters<typeof f.ports.git>) => {
        if (args[0][0] === 'status') inspections += 1
        return f.ports.git(...args)
      } }
      const service = new RunWorktrees(f.db.pool, f.managed, ports)
      const errors: unknown[] = []
      const report = (error: unknown) => errors.push(error)
      const now = new Date()
      await service.cleanup(report, now)
      expect(await f.trees()).toEqual([expect.objectContaining({ state: 'retained' })])
      expect(inspections).toBe(1)
      await service.cleanup(report, new Date(now.getTime() + 60_000))
      expect(inspections).toBe(1)
      await service.cleanup(report, new Date(now.getTime() + 5 * 60_000))
      expect(inspections).toBe(2)
      expect(await readFile(join(tree.workingDirectory, 'keep.txt'), 'utf8')).toBe('retained edit\n')
      f.git(tree.workingDirectory, 'add', 'keep.txt')
      f.git(tree.workingDirectory, 'commit', '-m', 'Keep edits')
      await service.cleanup(report, new Date(now.getTime() + 6 * 60_000))
      expect(inspections).toBe(2)
      await service.cleanup(report, new Date(now.getTime() + 15 * 60_000))
      expect(errors).toEqual([])
      expect(await f.trees()).toEqual([expect.objectContaining({ state: 'removed' })])
      await expect(access(tree.workingDirectory)).rejects.toMatchObject({ code: 'ENOENT' })
      expect(f.git(f.db.directory, 'show', `${tree.branch}:keep.txt`)).toBe('retained edit')
    } finally { await f.db.close() }
  })
})

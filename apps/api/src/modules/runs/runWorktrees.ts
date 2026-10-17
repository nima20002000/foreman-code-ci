import { latestDefaultCommit, runWorkspaceGit } from '../sources/defaultBranch.js'
import { withTransaction } from '../../infrastructure/transaction.js'
export { latestDefaultCommit } from '../sources/defaultBranch.js'
import { removeCommittedWorktree } from '../sources/worktreeCleanup.js'
import { createHash } from 'node:crypto'
import { mkdir, open } from 'node:fs/promises'
import { join, relative } from 'node:path'
import type pg from 'pg'
import { RunWorktreeSchema, type RunWorktree, type AcceptedWorkflowRunV3 } from '@foreman-code/contracts/wave25'
import { ensureWorktreeGitIdentity, systemGitWorktreePorts, type GitWorktreePorts } from '../sources/gitWorktree.js'
import { directoryFlags, withPrivateDirectoryLock } from '../sources/privateFilesystem.js'
import { DomainError } from '../errors.js'

type Sql = Pick<pg.PoolClient, 'query'>
type Allocation = { root: string; checkoutRoot: string; record: RunWorktree; cleanupAttempts: number }
const CLEANUP_RETRY_MS = 5 * 60_000

/** Each execution owns its checkout; persisted Run-only allocations keep their existing identity. */
export class RunWorktrees {
  constructor(private readonly pool: pg.Pool, private readonly managedRoot: string,
    private readonly ports: GitWorktreePorts = systemGitWorktreePorts()) {}

  private async exclusive<T>(runId: string, allocationId: string, signal: AbortSignal,
    work: () => Promise<T>): Promise<T> {
    const key = createHash('sha256').update(runId).update('\0').update(allocationId).digest('hex')
    const path = join(this.managedRoot, '.locks', key)
    await mkdir(path, { recursive: true, mode: 0o700 })
    const directory = await open(path, directoryFlags)
    try {
      // The kernel releases this lock after a crash, without a database session or an expiring claim.
      return await withPrivateDirectoryLock(directory, work, { signal })
    } finally {
      await directory.close()
    }
  }

  private async requireActiveRun(sql: Sql, runId: string): Promise<void> {
    const terminal = (await sql.query<{ execution_state: string }>(
      'select execution_state from runs where id=$1 for share', [runId])).rows[0]
    if (!terminal || ['completed', 'interrupted'].includes(terminal.execution_state)) {
      throw new DomainError('RUN_WORKTREE_CLOSED', 'A terminal Run cannot allocate a worktree.', 409)
    }
  }

  private async inspectAllocation(sql: Sql, run: AcceptedWorkflowRunV3, allocationId: string) {
    const previous = await this.read(sql, run.id, allocationId)
    if (previous) {
      if (previous.record.state === 'removed' || previous.record.state === 'retained') {
        throw new DomainError('RUN_WORKTREE_CLOSED', 'The Run worktree is already closed.', 409)
      }
      return { kind: 'existing' as const, tree: previous }
    }
    const started = (await sql.query<{ directory: string }>(
      `select record->>'workingDirectory' as directory from harness_executions
        where run_id=$1 and ($2='' or id=$2) and record->>'workingDirectory' is not null limit 1`,
      [run.id, allocationId])).rows[0]
    if (started) {
      if (allocationId) {
        const previous = await this.read(sql, run.id, '')
        if (previous?.record.workingDirectory === started.directory && previous.record.state === 'active') {
          return { kind: 'existing' as const, tree: previous }
        }
      }
      if (started.directory !== run.executionLocation.rootPath) {
        throw new DomainError('RUN_WORKTREE_UNAVAILABLE', 'The accepted execution directory has no worktree record.', 409)
      }
      return { kind: 'skip' as const }
    }
    await this.requireActiveRun(sql, run.id)
    return { kind: 'allocate' as const }
  }

  private async reserveAllocation(run: AcceptedWorkflowRunV3, allocationId: string, signal: AbortSignal) {
    const root = run.executionLocation.rootPath
    const probe = await this.ports.git(['rev-parse', '--show-toplevel'], { cwd: root, signal })
    if (probe.code !== 0) {
      if (!probe.stderr.includes('not a git repository')) {
        throw new DomainError('RUN_WORKTREE_UNAVAILABLE', 'The workspace Git repository could not be inspected.', 409)
      }
      return undefined
    }
    const repositoryRoot = probe.stdout.trim()
    const baseCommit = await latestDefaultCommit(this.ports, repositoryRoot, signal)
    const namespace = createHash('sha256').update(run.workspaceId).digest('hex')
    const name = createHash('sha256').update(run.id).update('\0').update(allocationId).digest('hex')
    const branch = `foreman/run-${name}`
    const checkoutRoot = join(this.managedRoot, namespace, branch.slice('foreman/'.length))
    const workingDirectory = join(checkoutRoot, relative(repositoryRoot, root))
    const record = RunWorktreeSchema.parse({ workingDirectory, branch, baseCommit, state: 'preparing',
      ...(allocationId ? { executionId: allocationId } : {}) })
    return withTransaction(this.pool, async sql => {
      await this.requireActiveRun(sql, run.id)
      await sql.query(`insert into run_worktrees(run_id,repository_root,record,allocation_id,checkout_root)
        values($1,$2,$3::jsonb,$4,$5)`,
      [run.id, repositoryRoot, JSON.stringify(record), allocationId, checkoutRoot])
      return { root: repositoryRoot, checkoutRoot, record, cleanupAttempts: 0 }
    })
  }

  async prepare(run: AcceptedWorkflowRunV3, signal = AbortSignal.timeout(60_000),
    executionId = ''): Promise<RunWorktree | undefined> {
    return this.exclusive(run.id, executionId, signal, async () => {
      const state = await withTransaction(this.pool, sql => this.inspectAllocation(sql, run, executionId))
      if (state.kind === 'skip') return undefined
      const tree = state.kind === 'existing' ? state.tree : await this.reserveAllocation(run, executionId, signal)
      if (!tree) return undefined
      await this.prepareCheckout(run.id, tree.record.executionId ?? '', tree, signal)
      return tree.record
    })
  }

  private async prepareCheckout(runId: string, allocationId: string, tree: Allocation, signal: AbortSignal) {
    const listed = await runWorkspaceGit(this.ports, ['worktree', 'list', '--porcelain'], tree.root, signal)
    let exists = listed.split('\n').includes(`worktree ${tree.checkoutRoot}`)
    if (exists && tree.record.state === 'preparing') {
      const reconciled = await removeCommittedWorktree(this.ports, tree.root,
        { ...tree.record, workingDirectory: tree.checkoutRoot }, signal)
      if (reconciled.state !== 'removed') {
        tree.record = { ...tree.record, state: 'retained', message: reconciled.message }
        await this.persist(runId, allocationId, tree.record)
        throw new DomainError('RUN_WORKTREE_UNAVAILABLE', 'An unfinished checkout contains changes and was retained.', 409)
      }
      exists = false
    }
    if (!exists) {
      await withTransaction(this.pool, sql => this.requireActiveRun(sql, runId))
      tree.record = { ...tree.record, state: 'preparing' }
      await this.persist(runId, allocationId, tree.record)
      await mkdir(join(tree.checkoutRoot, '..'), { recursive: true, mode: 0o700 })
      const { branch, baseCommit } = tree.record
      const existing = await this.ports.git(['rev-parse', '--verify', '--quiet', `refs/heads/${branch}`],
        { cwd: tree.root, signal })
      const args = existing.code === 0 ? ['worktree', 'add', tree.checkoutRoot, branch]
        : ['worktree', 'add', '-b', branch, tree.checkoutRoot, baseCommit]
      await runWorkspaceGit(this.ports, args, tree.root, signal)
    }
    await this.verify(tree.record, signal)
    if (tree.record.state === 'preparing') {
      tree.record = { ...tree.record, state: 'active' }
      await withTransaction(this.pool, async sql => {
        await this.requireActiveRun(sql, runId)
        await this.update(sql, runId, allocationId, tree.record)
      })
    }
  }

  async verify(tree: RunWorktree, signal = AbortSignal.timeout(10_000)): Promise<void> {
    const branch = await runWorkspaceGit(this.ports, ['symbolic-ref', '--quiet', '--short', 'HEAD'], tree.workingDirectory, signal)
    if (branch !== tree.branch) throw new DomainError('RUN_WORKTREE_CHANGED', 'The Run worktree is on another branch.', 409)
    await ensureWorktreeGitIdentity(this.ports, tree.workingDirectory, signal)
  }

  private async read(sql: Sql, runId: string, allocationId: string): Promise<Allocation | undefined> {
    const row = (await sql.query<{
      repository_root: string; record: unknown; checkout_root: string; cleanup_attempts: number
    }>(`select repository_root,record,checkout_root,cleanup_attempts from run_worktrees
      where run_id=$1 and allocation_id=$2`, [runId, allocationId])).rows[0]
    return row ? { root: row.repository_root, checkoutRoot: row.checkout_root,
      record: RunWorktreeSchema.parse(row.record), cleanupAttempts: row.cleanup_attempts } : undefined
  }

  private async update(sql: Sql, runId: string, allocationId: string, record: RunWorktree) {
    await sql.query('update run_worktrees set record=$2::jsonb where run_id=$1 and allocation_id=$3',
      [runId, JSON.stringify(record), allocationId])
  }

  private persist(runId: string, allocationId: string, record: RunWorktree) {
    return withTransaction(this.pool, sql => this.update(sql, runId, allocationId, record))
  }

  async cleanup(report: (error: unknown) => void, now = new Date()): Promise<void> {
    const rows = await this.pool.query<{ run_id: string; allocation_id: string }>(
      `select w.run_id,w.allocation_id from run_worktrees w join runs r on r.id=w.run_id
      where w.record->>'state' in ('active','preparing','retained') and w.cleanup_after <= $1
      and r.execution_state in ('completed','interrupted')
      and not exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)
      and not exists(select 1 from execution_native_sessions n join harness_executions e on e.id=n.execution_id
        where e.run_id=r.id and n.workflow_finalized_at is null)
      order by w.cleanup_after,w.created_at limit 100`, [now])
    for (const row of rows.rows) {
      try { await this.cleanupAllocation(row.run_id, row.allocation_id, now) } catch (error) { report(error) }
    }
  }

  private async cleanupAllocation(runId: string, allocationId: string, now: Date): Promise<void> {
    const signal = AbortSignal.timeout(30_000)
    return this.exclusive(runId, allocationId, signal, async () => {
      const tree = await withTransaction(this.pool, async sql => {
        const eligible = await sql.query(`select 1 from runs r where r.id=$1
          and r.execution_state in ('completed','interrupted')
          and not exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)
          and not exists(select 1 from execution_native_sessions n join harness_executions e on e.id=n.execution_id
            where e.run_id=r.id and n.workflow_finalized_at is null)
          and exists(select 1 from run_worktrees w where w.run_id=r.id and w.allocation_id=$2
            and w.cleanup_after <= $3) for share`, [runId, allocationId, now])
        return eligible.rowCount === 1 ? this.read(sql, runId, allocationId) : undefined
      })
      if (!tree || tree.record.state === 'removed') return
      const removed = await removeCommittedWorktree(this.ports, tree.root,
        { ...tree.record, workingDirectory: tree.checkoutRoot }, signal)
      const record = { ...removed, workingDirectory: tree.record.workingDirectory }
      const retryMs = Math.min(24 * 60 * 60_000, CLEANUP_RETRY_MS * 2 ** Math.min(tree.cleanupAttempts, 9))
      await withTransaction(this.pool, async sql => {
        await sql.query(`update run_worktrees set record=$2::jsonb,cleanup_attempts=cleanup_attempts+1,
          cleanup_after=$4 where run_id=$1 and allocation_id=$3`,
        [runId, JSON.stringify(record), allocationId, new Date(now.getTime() + retryMs)])
      })
    })
  }
}

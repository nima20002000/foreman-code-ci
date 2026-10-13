import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { WorkspaceSchema } from '@foreman-code/contracts'
import type { CiCommits, HostCiEndpoint } from './service.js'
import { componentLogger } from '../diagnostics/logger.js'

const log = componentLogger('jobs')

/** Branch discovery has its own timer: network and idle preparation cannot hold up CI dispatch. */
export class CiPrewarmService {
  private timer: NodeJS.Timeout | undefined
  private readonly delivered = new Map<string, Set<string>>()
  private polling: Promise<void> | undefined

  constructor(private readonly pool: pg.Pool, private readonly commits: Pick<CiCommits, 'heads'>,
    private readonly endpoint: HostCiEndpoint) {}

  start(intervalMs = 5000) {
    this.timer ??= setInterval(() => { void this.poll() }, intervalMs)
    this.timer.unref()
  }

  close() {
    clearInterval(this.timer)
    this.timer = undefined
    return this.polling
  }

  poll(): Promise<void> {
    this.polling ??= this.pollOnce().catch(error => log.warn({ err: error }, 'CI warm-up discovery failed'))
      .finally(() => { this.polling = undefined })
    return this.polling
  }

  private async pollOnce() {
    if (!this.commits.heads) return
    const computers = (await this.endpoint.computers()).filter(computer => computer.hostRef.kind !== 'cloud')
    if (!computers.length) return
    const rows = (await this.pool.query<{ record: unknown }>('select record from workspaces')).rows
    const repositories = new Set(rows.map(row => WorkspaceSchema.parse(row.record).repository)
      .filter(repository => repository !== null && repository !== undefined)
      .map(repository => `${repository.owner}/${repository.name}`))
    for (const repository of repositories) {
      const heads = await this.commits.heads(repository)
      const queued = (await this.pool.query<{ busy: boolean }>(
        "select exists(select 1 from ci_runs where state='queued') as busy")).rows[0]?.busy
      if (queued) return
      await Promise.all(computers.map(async computer => {
        try {
          const status = await this.endpoint.request(computer, { operation: 'status' })
          if (status.operation !== 'status' || !status.ready || !status.prewarmSupported
            || (status.slotsUsed ?? 0) >= (status.slotsTotal ?? 1)) return
          const key = `${computer.key}:${repository}`
          const commits = new Set(heads.map(head => head.commit))
          const delivered = new Set([...(this.delivered.get(key) ?? [])].filter(commit => commits.has(commit)))
          if (status.warmup && ['failed', 'canceled', 'lost'].includes(status.warmup.run.state)) {
            delivered.delete(status.warmup.commit)
          }
          this.delivered.set(key, delivered)
          for (const commit of commits) {
            if (delivered.has(commit)) continue
            const reply = await this.endpoint.request(computer, { operation: 'start', warmup: true,
              runId: randomUUID(), repository, commit, suite: 'install' })
            if (reply.operation !== 'start') continue
            if (reply.run.state !== 'queued') delivered.add(commit)
            if (['starting', 'running', 'queued'].includes(reply.run.state)) break
          }
        } catch (error) {
          log.warn({ err: error, computer: computer.key, repository }, 'CI warm-up unavailable')
        }
      }))
    }
  }
}

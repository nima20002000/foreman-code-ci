import { gunzipSync } from 'node:zlib'
import type { CircleCredits } from '@foreman-code/contracts'
import type { CircleCreditAllowance } from '@foreman-code/contracts/management'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { CloudHttp } from './cloudHttp.js'

const log = componentLogger('jobs')
/** CircleCI allows 10 usage exports per hour per org; one per ten minutes stays well inside that. */
const REFRESH_MS = 10 * 60_000
const POLL_MS = 6_000
const EXPORT_WAIT_MS = 120_000
/** A reading older than this, or from an earlier month, is no longer shown. */
const MAX_AGE_MS = 60 * 60_000

export interface CircleCreditsReading { credits: CircleCredits | null; creditsUnavailable?: string }

interface Snapshot { used: number; asOf: string; periodStart: string }
interface AccountState {
  owner?: string
  orgId?: string
  job?: { id: string; periodStart: string }
  snapshot?: Snapshot
  failure?: string
  attemptedAt: number
  refreshing?: Promise<void> | undefined
}

function monthStart(at: number) {
  const date = new Date(at)
  return new Date(Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), 1)).toISOString()
}

/** Sums the total_credits column of one usage export CSV (RFC 4180 quoting). */
export function sumTotalCredits(csv: string): number {
  let column = -1
  let total = 0
  let row = 0
  let field = 0
  let value = ''
  let quoted = false
  const endField = () => {
    if (row === 0) { if (value.trim().toLowerCase() === 'total_credits') column = field }
    else if (field === column) { const credits = Number(value); if (Number.isFinite(credits)) total += credits }
    value = ''
    field++
  }
  const endRow = () => {
    endField()
    if (row === 0 && column === -1) throw new DomainError('CI_CLOUD_FAILED', 'CircleCI usage export has no total_credits column.', 502)
    row++
    field = 0
  }
  for (let index = 0; index < csv.length; index++) {
    const char = csv[index]!
    if (quoted) {
      if (char !== '"') value += char
      else if (csv[index + 1] === '"') { value += '"'; index++ }
      else quoted = false
    } else if (char === '"') quoted = true
    else if (char === ',') endField()
    else if (char === '\n') endRow()
    else if (char !== '\r') value += char
  }
  if (value !== '' || field > 0) endRow()
  return total
}

/**
 * Remaining CircleCI credits per org, estimated as the configured monthly allowance (400,000 open-source Linux credits
 * per org on the Free plan unless overridden) minus this month's usage from CircleCI's usage export (CircleCI has no
 * API for the plan balance). One export per account at most every ten
 * minutes, shared by every reader; readers only ever see the cached value.
 */
export class CircleCreditUsage {
  private readonly states = new Map<string, AccountState>()
  private readonly now: () => number
  private readonly refreshMs: number
  private readonly pollMs: number
  private readonly waitMs: number

  constructor(private readonly http: Pick<CloudHttp, 'request' | 'check' | 'json' | 'downloadUrl'>, private readonly source: {
    allowance(): Promise<CircleCreditAllowance>
    /** The GitHub owner of the CircleCI org behind the workspace CI mirrors, or null when it is not a single owner. */
    primaryOwner(): Promise<string | null>
  }, options: { now?: () => number; refreshMs?: number; pollMs?: number; waitMs?: number } = {}) {
    this.now = options.now ?? Date.now
    this.refreshMs = options.refreshMs ?? REFRESH_MS
    this.pollMs = options.pollMs ?? POLL_MS
    this.waitMs = options.waitMs ?? EXPORT_WAIT_MS
  }

  /** `account` is the GitHub owner of a further CircleCI org; omit it for the workspace mirror's own org. */
  async reading(account?: string): Promise<CircleCreditsReading> {
    const key = (account ?? '').toLowerCase()
    let state = this.states.get(key)
    if (!state) {
      state = { attemptedAt: Number.NEGATIVE_INFINITY }
      this.states.set(key, state)
    }
    const current = state
    if (!current.refreshing && this.now() - current.attemptedAt >= this.refreshMs) {
      current.attemptedAt = this.now()
      current.refreshing = this.refresh(current, account).finally(() => { current.refreshing = undefined })
    }
    const snapshot = current.snapshot
    const fresh = snapshot && this.now() - Date.parse(snapshot.asOf) <= MAX_AGE_MS
      && snapshot.periodStart === monthStart(this.now())
    if (!fresh) return { credits: null, creditsUnavailable: current.failure ?? 'Credits are still being read.' }
    const allowance = await this.source.allowance()
    const owner = (current.owner ?? '').toLowerCase()
    const total = Object.entries(allowance.accounts).find(([name]) => name.toLowerCase() === owner)?.[1]
      ?? allowance.defaultMonthlyCredits
    return { credits: { total, used: snapshot.used, remaining: Math.max(0, total - snapshot.used), asOf: snapshot.asOf } }
  }

  private async refresh(state: AccountState, account: string | undefined) {
    try {
      const owner = account ?? await this.source.primaryOwner()
      if (!owner) throw new DomainError('CI_CLOUD_FAILED', 'The CircleCI organization of the CI mirror is not known.', 502)
      state.owner = owner
      state.orgId ??= await this.organizationId(owner)
      const periodStart = monthStart(this.now())
      if (state.job && state.job.periodStart !== periodStart) delete state.job
      state.job ??= { id: await this.createExport(state.orgId, periodStart), periodStart }
      const urls = await this.waitForExport(state, state.orgId, state.job.id)
      if (!urls) throw new DomainError('CI_CLOUD_FAILED', 'CircleCI usage export is not ready yet.', 502)
      let used = 0
      for (const url of urls) {
        const file = await this.http.downloadUrl(url, 120_000)
        used += sumTotalCredits((file[0] === 0x1f && file[1] === 0x8b ? gunzipSync(file) : file).toString('utf8'))
      }
      delete state.job
      state.snapshot = { used: Math.round(used), asOf: new Date(this.now()).toISOString(), periodStart }
      delete state.failure
    } catch (error) {
      state.failure = error instanceof DomainError ? error.message : 'CircleCI usage could not be read.'
      log.warn({ operation: 'read CircleCI credits', err: error, owner: state.owner }, 'CircleCI credit usage could not be read')
    }
  }

  private async call(path: string, what: string, options: { method?: string; body?: string } = {}) {
    const response = await this.http.request(path, { timeoutMs: 60_000, ...options })
    if (!response) throw new DomainError('CI_CLOUD_CREDENTIALS_UNAVAILABLE', 'CircleCI is not logged in on Main.', 503)
    await this.http.check(response, detail => `CircleCI did not accept ${what}: ${detail}`)
    return response
  }

  private async organizationId(owner: string) {
    const response = await this.call('/api/v2/me/collaborations', 'the organization lookup')
    const orgs = await this.http.json<{ id: string; name?: string; slug?: string; vcs_type?: string }[]>(response)
    const match = orgs.find(org => org.vcs_type !== 'bitbucket'
      && (org.name?.toLowerCase() === owner.toLowerCase() || org.slug?.toLowerCase() === `gh/${owner.toLowerCase()}`))
    if (!match) throw new DomainError('CI_CLOUD_FAILED', `CircleCI organization ${owner} is not visible to Main's login.`, 502)
    return match.id
  }

  private async createExport(orgId: string, start: string) {
    const response = await this.call(`/api/v2/organizations/${encodeURIComponent(orgId)}/usage_export_job`,
      'the usage export', { method: 'POST', body: JSON.stringify({ start, end: new Date(this.now()).toISOString() }) })
    return (await this.http.json<{ usage_export_job_id: string }>(response)).usage_export_job_id
  }

  /** The export's CSV links once it completed; null when it is still running after the wait. */
  private async waitForExport(state: AccountState, orgId: string, jobId: string): Promise<string[] | null> {
    const deadline = Date.now() + this.waitMs
    for (;;) {
      const response = await this.call(
        `/api/v2/organizations/${encodeURIComponent(orgId)}/usage_export_job/${encodeURIComponent(jobId)}`, 'the usage export read')
      const job = await this.http.json<{ state: string; download_urls?: string[] | null; error_reason?: string }>(response)
      if (job.state === 'completed') return job.download_urls ?? []
      if (job.state === 'failed') {
        delete state.job
        throw new DomainError('CI_CLOUD_FAILED', `CircleCI usage export failed: ${(job.error_reason ?? 'unknown').slice(0, 200)}`, 502)
      }
      if (Date.now() + this.pollMs > deadline) return null
      await new Promise(resolve => setTimeout(resolve, this.pollMs))
    }
  }
}

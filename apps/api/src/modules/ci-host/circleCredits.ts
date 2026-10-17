import { gunzipSync } from 'node:zlib'
import type { CircleAccountCredits, CircleOrgCredits } from '@foreman-code/contracts'
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

export interface CircleCreditsReading { credits: CircleAccountCredits | null; creditsUnavailable?: string }

interface Snapshot { used: number; asOf: string; periodStart: string }
interface OrgState {
  /** The GitHub owner of the CircleCI organization. */
  name: string
  id: string
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
 * Remaining CircleCI credits for the login's GitHub organizations. CircleCI has no API for the plan balance, so each
 * organization's remaining credits are its monthly allowance (400,000 for open-source Linux builds on the Free plan,
 * overridable per organization) minus the organization's usage this month from CircleCI's usage export. One export
 * per organization at most every ten minutes, shared by every reader; readers only ever see the cached values.
 */
export class CircleCreditUsage {
  private readonly orgs = new Map<string, OrgState>()
  private readonly listing: { attemptedAt: number; failure?: string; refreshing?: Promise<void> | undefined } = {
    attemptedAt: Number.NEGATIVE_INFINITY }
  private readonly now: () => number
  private readonly refreshMs: number
  private readonly pollMs: number
  private readonly waitMs: number

  constructor(private readonly http: Pick<CloudHttp, 'request' | 'check' | 'json' | 'downloadUrl'>, private readonly source: {
    allowance(): Promise<CircleCreditAllowance>
  }, options: { now?: () => number; refreshMs?: number; pollMs?: number; waitMs?: number } = {}) {
    this.now = options.now ?? Date.now
    this.refreshMs = options.refreshMs ?? REFRESH_MS
    this.pollMs = options.pollMs ?? POLL_MS
    this.waitMs = options.waitMs ?? EXPORT_WAIT_MS
  }

  async reading(): Promise<CircleCreditsReading> {
    if (!this.listing.refreshing && this.now() - this.listing.attemptedAt >= this.refreshMs) {
      this.listing.attemptedAt = this.now()
      this.listing.refreshing = this.listOrganizations().finally(() => { this.listing.refreshing = undefined })
    }
    for (const state of this.orgs.values()) this.refreshIfDue(state)
    if (!this.orgs.size) return { credits: null, creditsUnavailable: this.listing.failure ?? 'Credits are still being read.' }
    const allowance = await this.source.allowance()
    const orgs = [...this.orgs.values()].map(state => this.organizationReading(state, allowance))
    const counted = orgs.flatMap(org => org.credits ? [org.credits] : [])
    const total = counted.length ? {
      total: counted.reduce((sum, credits) => sum + credits.total, 0),
      used: counted.reduce((sum, credits) => sum + credits.used, 0),
      remaining: counted.reduce((sum, credits) => sum + credits.remaining, 0),
      asOf: counted.map(credits => credits.asOf).sort()[0]!,
    } : null
    return { credits: { orgs, total } }
  }

  private organizationReading(state: OrgState, allowance: CircleCreditAllowance): CircleOrgCredits {
    const snapshot = state.snapshot
    const fresh = snapshot && this.now() - Date.parse(snapshot.asOf) <= MAX_AGE_MS
      && snapshot.periodStart === monthStart(this.now())
    if (!fresh) return { org: state.name, credits: null, unavailable: state.failure ?? 'Credits are still being read.' }
    const total = Object.entries(allowance.accounts).find(([name]) => name.toLowerCase() === state.name.toLowerCase())?.[1]
      ?? allowance.defaultMonthlyCredits
    return { org: state.name, credits: { total, used: snapshot.used, remaining: Math.max(0, total - snapshot.used), asOf: snapshot.asOf } }
  }

  /** The login's GitHub organizations; a failed listing keeps the known ones. */
  private async listOrganizations() {
    try {
      const response = await this.call('/api/v2/me/collaborations', 'the organization lookup')
      const found = await this.http.json<{ id: string; name?: string; slug?: string; vcs_type?: string }[]>(response)
      for (const org of found) {
        const name = org.slug?.startsWith('gh/') ? org.slug.slice(3) : org.name
        if (org.vcs_type !== 'github' || !name) continue
        const known = this.orgs.get(name.toLowerCase())
        if (known) known.id = org.id
        else this.orgs.set(name.toLowerCase(), { name, id: org.id, attemptedAt: Number.NEGATIVE_INFINITY })
      }
      delete this.listing.failure
      if (!this.orgs.size) this.listing.failure = 'The CircleCI login belongs to no GitHub organization.'
    } catch (error) {
      this.listing.failure = error instanceof DomainError ? error.message : 'CircleCI organizations could not be read.'
      log.warn({ operation: 'list CircleCI organizations', err: error }, 'CircleCI organizations could not be listed')
    }
    for (const state of this.orgs.values()) this.refreshIfDue(state)
  }

  private refreshIfDue(state: OrgState) {
    if (state.refreshing || this.now() - state.attemptedAt < this.refreshMs) return
    state.attemptedAt = this.now()
    state.refreshing = this.refresh(state).finally(() => { state.refreshing = undefined })
  }

  private async refresh(state: OrgState) {
    try {
      const periodStart = monthStart(this.now())
      if (state.job && state.job.periodStart !== periodStart) delete state.job
      state.job ??= { id: await this.createExport(state.id, periodStart), periodStart }
      const urls = await this.waitForExport(state, state.id, state.job.id)
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
      log.warn({ operation: 'read CircleCI credits', err: error, owner: state.name }, 'CircleCI credit usage could not be read')
    }
  }

  private async call(path: string, what: string, options: { method?: string; body?: string } = {}) {
    const response = await this.http.request(path, { timeoutMs: 60_000, ...options })
    if (!response) throw new DomainError('CI_CLOUD_CREDENTIALS_UNAVAILABLE', 'CircleCI is not logged in on Main.', 503)
    await this.http.check(response, detail => `CircleCI did not accept ${what}: ${detail}`)
    return response
  }

  private async createExport(orgId: string, start: string) {
    const response = await this.call(`/api/v2/organizations/${encodeURIComponent(orgId)}/usage_export_job`,
      'the usage export', { method: 'POST', body: JSON.stringify({ start, end: new Date(this.now()).toISOString() }) })
    return (await this.http.json<{ usage_export_job_id: string }>(response)).usage_export_job_id
  }

  /** The export's CSV links once it completed; null when it is still running after the wait. */
  private async waitForExport(state: OrgState, orgId: string, jobId: string): Promise<string[] | null> {
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

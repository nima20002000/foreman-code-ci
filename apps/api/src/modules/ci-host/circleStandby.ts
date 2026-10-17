import type { CircleAccountRole, CircleSchedulingRole } from '@foreman-code/contracts'
import type { CircleCreditsReader, CircleCreditsReading } from './circleCredits.js'
import { CircleCreditCache, circleCreditKey, circleMonthStart } from './circleCreditCache.js'

/** The owner is a GitHub organization; circleAccountId chooses its credential-bearing login. */
export interface CircleOrganization {
  owner: string
  circleAccountId: string
  role: CircleAccountRole
  mirrorNames: ReadonlySet<string>
  ready: boolean
}
export interface CircleSchedulingReading extends CircleCreditsReading {
  schedulingRole: CircleSchedulingRole
  schedulingReason: string
}
export const circleOrgKey = circleCreditKey
export const CIRCLE_EXHAUSTED_CREDITS = 20_000

function reason(role: CircleSchedulingRole): string {
  if (role === 'exhausted') return 'Estimated credits left reached the 20,000 reserve for this UTC month.'
  if (role === 'standby') return 'Standby capacity waits for a primary organization to reach its credit reserve.'
  return 'Active for new CI jobs.'
}

/** Scheduler, start admission and public readback use the same per-org replacement policy. */
export class CircleStandby {
  constructor(private readonly organizations: () => Promise<CircleOrganization[]>,
    private readonly credits: CircleCreditsReader, private readonly cache = new CircleCreditCache(),
    private readonly now: () => number = Date.now) {}

  async roles(mirrorName?: string): Promise<Map<string, CircleSchedulingReading>> {
    const orgs = await this.organizations()
    const readings = await Promise.all(orgs.map(org => this.credits.reading(org.owner, org.circleAccountId)))
    const month = circleMonthStart(this.now())
    return this.cache.transaction(state => {
      const statuses = orgs.map((org, index) => {
        const key = circleOrgKey(org.owner, org.circleAccountId)
        const saved = state[key] ??= { attempts: [] }
        if (saved.policy?.month !== month) saved.policy = { month, exhausted: false, activated: false }
        const reading = readings[index]!
        if (reading.credits) saved.policy.exhausted = reading.credits.remaining <= CIRCLE_EXHAUSTED_CREDITS
        return { org, key, reading, policy: saved.policy,
          hasMirror: mirrorName ? org.mirrorNames.has(mirrorName) : org.mirrorNames.size > 0 }
      })
      let replacements = statuses.filter(status => status.org.role === 'primary' && status.policy.exhausted).length
      const selected = new Set<string>()
      const standbys = statuses.filter(status => status.org.role === 'standby')
        .sort((left, right) => left.org.owner.toLowerCase().localeCompare(right.org.owner.toLowerCase()))
      for (const status of standbys) {
        const eligible = !status.policy.exhausted && status.org.ready && status.hasMirror
          && (status.reading.credits !== null || status.policy.activated)
        if (replacements > 0 && eligible) {
          selected.add(status.key)
          status.policy.activated = true
          replacements--
        }
      }
      return new Map(statuses.map(status => {
        let role: CircleSchedulingRole = 'standby'
        if (status.policy.exhausted) role = 'exhausted'
        else if (status.hasMirror && (status.org.role === 'primary' || selected.has(status.key))) role = 'active'
        return [status.key, { ...status.reading, schedulingRole: role, schedulingReason: reason(role) }]
      }))
    })
  }

  async eligible(owner: string, circleAccountId = 'default', mirrorName?: string): Promise<boolean> {
    return (await this.roles(mirrorName)).get(circleOrgKey(owner, circleAccountId))?.schedulingRole === 'active'
  }

  async reading(owner: string, circleAccountId = 'default', mirrorName?: string): Promise<CircleSchedulingReading> {
    return (await this.roles(mirrorName)).get(circleOrgKey(owner, circleAccountId)) ?? {
      credits: null, creditsUnavailable: 'This organization is no longer registered.',
      schedulingRole: 'standby', schedulingReason: 'This organization is unavailable for new CI jobs.',
    }
  }
}

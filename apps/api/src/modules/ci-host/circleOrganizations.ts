import type { CloudCi } from './cloud.js'
import type { CircleOrganization } from './circleStandby.js'

/** Registered organization inputs shared by production selection and its readiness checks. */
export async function circleOrganizations(clouds: readonly CloudCi[]): Promise<CircleOrganization[]> {
  return clouds.flatMap(cloud => {
    const account = cloud.provider.account
    if (cloud.provider.id !== 'circleci' || !account || account.registered === false) return []
    const circleAccountId = cloud.provider.circleAccountId ?? 'default'
    return [{ owner: account.owner, circleAccountId,
      role: account.role ?? (circleAccountId === 'default' ? 'primary' : 'standby'),
      mirrorNames: account.mirrorNames, ready: cloud.readinessSnapshot() }]
  })
}

import type { CloudCi } from './cloud.js'
import type { CircleOrganization } from './circleStandby.js'

/** Registered organization inputs shared by production selection and its readiness checks. */
export async function circleOrganizations(clouds: readonly CloudCi[]): Promise<CircleOrganization[]> {
  return Promise.all(clouds.flatMap(cloud => {
    const account = cloud.provider.account
    if (cloud.provider.id !== 'circleci' || !account || account.registered === false) return []
    return [(async () => ({ owner: account.owner, circleAccountId: cloud.provider.circleAccountId ?? 'default',
      role: account.role ?? 'primary', mirrorNames: account.mirrorNames, ready: await cloud.ready() }))()]
  }))
}

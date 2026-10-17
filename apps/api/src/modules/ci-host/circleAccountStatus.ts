import type pg from 'pg'
import type { CircleAccount } from '@foreman-code/contracts/management'
import type { CircleAccountStatusReader } from './circleAccounts.js'
import type { CloudCi } from './cloud.js'
import { cloudCiId } from './cloudProviders.js'
import { CircleStandby, circleOrgKey } from './circleStandby.js'

/** Account readback uses the fleet owned by dispatch. */
export class CircleAccountFleetStatus implements CircleAccountStatusReader {
  constructor(private readonly pool: pg.Pool, private readonly mainId: string,
    private readonly directory: CircleAccountStatusReader, private readonly clouds: readonly CloudCi[],
    private readonly standby: CircleStandby) {}

  async read(account: CircleAccount) {
    const setup = await this.directory.read(account)
    const counts = (await this.pool.query<{ segment: string; running: number }>(`select
      split_part(host_key,':',3) as segment,count(*)::int as running from ci_runs
      where state in ('starting','running') and host_key like $1 group by 1`, [`${this.mainId}:cloud:%`])).rows
    const roles = await this.standby.roles()
    const orgs = await Promise.all(setup.orgs.map(async org => {
      const cloud = this.clouds.find(value => value.provider.circleAccountId === account.id
        && value.provider.account?.owner.toLowerCase() === org.account.toLowerCase())
      if (!cloud) return org
      const reading = roles.get(circleOrgKey(org.account, account.id))
      return { ...org, ...reading, ready: await cloud.ready() && cloud.provider.account!.mirrorNames.size > 0,
        running: counts.find(row => row.segment === cloudCiId(cloud.provider))?.running ?? 0 }
    }))
    const ready = setup.tokenConfigured && orgs.length > 0 && orgs.every(org => org.ready)
    return { ...setup, ready, reasons: ready ? [] : setup.reasons, orgs }
  }
}

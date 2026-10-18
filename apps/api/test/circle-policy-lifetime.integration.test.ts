import { expect, it } from 'vitest'
import { createDatabase } from '../src/infrastructure/database.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { CircleCreditCache, circleCreditKey, circleMonthStart } from '../src/modules/ci-host/circleCreditCache.js'
import { CircleCreditUsage } from '../src/modules/ci-host/circleCredits.js'
import { CircleStandby, circleOrgKey } from '../src/modules/ci-host/circleStandby.js'
import { CiDispatchDeadlineError, withCiDispatchDeadline } from '../src/modules/ci-host/dispatchDeadline.js'
import { deferred } from './helpers/deferred.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

it('shares a slow credit-policy read with start admission without inheriting the expired scheduling pass', async () => {
  const fixture = await migratedDatabase()
  const database = createDatabase({ connectionString: fixture.databaseUrl, maxConnections: 4, connectionTimeoutMs: 1000 })
  const repository = new PostgresFoundationSettingsRepository(database.pool)
  const cache = new CircleCreditCache()
  const now = Date.now()
  const at = new Date(now).toISOString()
  const release = deferred()
  const finishPass = deferred()
  let settled: Promise<PromiseSettledResult<unknown>[]> | undefined
  let lock: Promise<void> | undefined
  try {
    await cache.transaction(states => {
      states[circleCreditKey('fixture-org')] = { attempts: [], lastAttemptAt: now,
        snapshot: { used: 0, asOf: at, windowEnd: at, periodStart: circleMonthStart(now) } }
    })
    const usage = new CircleCreditUsage(() => { throw new Error('Unexpected fixture export') }, {
      allowance: async () => (await repository.getCircleCreditAllowance()).value,
      primaryOwner: async () => 'fixture-org',
    }, { cache, now: () => now })
    const selector = new CircleStandby(async () => [{ owner: 'fixture-org', circleAccountId: 'default',
      role: 'primary', ready: true, mirrorNames: new Set(['ci-mirror']) }], usage, cache, () => now)
    lock = cache.transaction(async () => { await release.promise })
    let evaluation: ReturnType<CircleStandby['roles']> | undefined
    const pass = withCiDispatchDeadline(async () => {
      evaluation = selector.roles('ci-mirror')
      await finishPass.promise
    })
    const expired = expect(pass).rejects.toBeInstanceOf(CiDispatchDeadlineError)
    const admission = selector.eligible('fixture-org', 'default', 'ci-mirror')
    settled = Promise.allSettled([evaluation!, admission])
    await expired
    release.resolve()
    await lock
    const results = await settled
    expect(results[0]).toMatchObject({ status: 'fulfilled' })
    expect(results[1]).toEqual({ status: 'fulfilled', value: true })
    expect((await selector.roles('ci-mirror')).get(circleOrgKey('fixture-org'))?.schedulingRole).toBe('active')
  } finally {
    finishPass.resolve()
    release.resolve()
    await lock
    await settled
    await database.close()
    await fixture.close()
  }
})

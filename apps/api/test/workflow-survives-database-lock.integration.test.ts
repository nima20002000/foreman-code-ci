import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { faultWorkflowFixture, expectSuccessfulFaultRecovery } from './helpers/faultWorkflowFixture.js'
import { readOperationalFailures } from '../src/modules/diagnostics/operationalFailures.js'
import { deferred } from './helpers/deferred.js'
import { readUntil } from './helpers/observableCondition.js'
import { agent3Database } from './helpers/workflowDatabase.js'
import { postgresEnabled } from './helpers/database.js'
import { createTestPool } from './helpers/testPool.mjs'

describe.runIf(postgresEnabled)('workflow reporting under database contention', () => {
  let fixture: Awaited<ReturnType<typeof faultWorkflowFixture>>
  let database: Awaited<ReturnType<typeof agent3Database>>
  beforeAll(async () => {
    database = await agent3Database()
    // A competing transaction must not consume the pool capacity needed to report its timeout.
    database.pool.options.max = 1
    fixture = await faultWorkflowFixture({ database })
    await fixture.prepareEntry()
  }, 10_000)
  afterAll(async () => {
    try { await fixture?.close() }
    finally { await database?.close() }
  }, 10_000)

  // A Run lock held until Agent reporting has hit its statement deadline must retry reporting and expose the database delay in operational diagnostics.
  it('finishes while a separate transaction locks its Run during Agent reporting', async () => {
    await fixture.launch()
    await fixture.active()
    // The Run lock also blocks sibling startup. Isolate reporting contention so a
    // legitimate infrastructure retry there cannot violate the one-attempt check.
    const ready = await readUntil(fixture.read, details => details.executions.some(execution =>
      execution.workflowNodeId === fixture.sibling.id && execution.state === 'completed'
      && execution.result?.outcome === 'succeeded'),
    { timeoutMs: 8_000, description: 'the sibling Agent completed before reporting contention' })
    const reporting = ready.executions.find(execution => execution.workflowNodeId === fixture.affected.id)!
    expect(reporting).toMatchObject({ state: 'running', nativeSessionId: expect.any(String) })
    await fixture.setReportingDeadline(1_000)
    const retryFailures = () => readOperationalFailures().find(value => value.operation === 'retry database operation')
    const retriesBefore = retryFailures()?.failureCount ?? 0
    const locked = deferred<void>()
    // Reporting needs the application pool even while this external transaction holds the Run lock.
    const locker = createTestPool({ ...database.pool.options, max: 1 })
    const hold = withTransaction(locker, async sql => {
      await sql.query('select id from runs where id=$1 for update', [fixture.base.f.run.id])
      locked.resolve()
      // Hold the lock until reporting is actually blocked and has timed out once, however long a loaded runner takes to reach it.
      await readUntil(async () => retryFailures()?.failureCount ?? 0, count => count > retriesBefore,
        { timeoutMs: 10_000, description: 'Agent reporting retried after its statement deadline under Run contention' })
    })
    const settledLock = Promise.allSettled([hold])
    try {
      await Promise.race([locked.promise, hold.then(() => {
        throw new Error('The lock transaction finished before signaling acquisition')
      })])
      fixture.release()
      await hold
      const details = await fixture.finished()
      expectSuccessfulFaultRecovery(details, fixture)
      expect(details.executions.filter(execution => execution.workflowNodeId === fixture.affected.id))
        .toEqual([expect.objectContaining({ id: reporting.id, attempt: 1,
          nativeSessionId: reporting.nativeSessionId })])
      expect(retryFailures()).toMatchObject({ component: 'engine', status: 'degraded' })
      expect(retryFailures()!.failureCount).toBeGreaterThan(retriesBefore)
    } finally {
      await settledLock
      await locker.end()
    }
    // Two full remote launches on a loaded CI host need more than 18 s; finished() still fails a Run that stops changing.
  }, 30_000)
})

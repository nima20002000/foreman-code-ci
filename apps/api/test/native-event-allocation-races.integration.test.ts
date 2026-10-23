import type { HarnessNativeEvent } from '@foreman-code/contracts'
import { describe, expect, it } from 'vitest'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { deferred } from './helpers/deferred.js'
import { appendNativeEvent } from '../src/modules/runs/nativeEvents.js'
import { counts, event, forcedRace, nextSequence, withSharedAllocationDatabase } from './native-event-allocation.test-support.js'

describe('PostgreSQL native event allocation races', () => {
  const database = withSharedAllocationDatabase()

  it('forces the stale-snapshot race; stores both events and their Activity references exactly once', async () => {
    await database(async (pool) => {
      const first = event(17); const second = event(18)
      await forcedRace(pool, first, second)
      const stored = await pool.query<{ sequence: number; source_sequence: number; record: HarnessNativeEvent; activity_count: number }>(`select
        n.sequence,n.source_sequence,n.record,count(a.sequence)::integer as activity_count
        from harness_native_events n left join run_activity a on a.harness_execution_id=n.execution_id
          and (a.payload->>'nativeEventSequence')::integer=n.sequence and a.kind='harness_output'
        group by n.execution_id,n.sequence order by n.sequence`)
      expect(stored.rows.map((row) => row.sequence)).toEqual([0, 1])
      expect(stored.rows.map((row) => row.source_sequence)).toEqual([17, 18])
      for (const row of stored.rows) {
        expect(row.record.sequence).toBe(row.sequence)
        expect(row.activity_count).toBe(1)
      }
      const before = await nextSequence(pool)
      await appendNativeEvent(pool, first)
      await appendNativeEvent(pool, second)
      expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      expect(await nextSequence(pool)).toBe(before)
      for (const original of [first, second]) {
        await expect(appendNativeEvent(pool, { ...original, payload: { text: 'different history' } }))
          .rejects.toMatchObject({ code: 'NATIVE_EVENT_IDENTITY_CONFLICT', status: 409 })
      }
      expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      expect(await nextSequence(pool)).toBe(before)
    })
  }, 20_000)

  it('serializes overlapping Activity commits and keeps cursor pages lossless while publication is paused', async () => {
    await database(async pool => {
      const a = await pool.connect()
      const b = await pool.connect()
      const gateA = await pool.connect()
      const gateB = await pool.connect()
      const gateReadyA = deferred<number>(), gateReadyB = deferred<number>()
      const releaseGateA = deferred(), releaseGateB = deferred()
      const eventReadyA = deferred(), eventReadyB = deferred()
      const publishA = deferred(), publishB = deferred()
      let gateTransactionA: Promise<void> | undefined, gateTransactionB: Promise<void> | undefined
      let eventTransactionA: Promise<void> | undefined, eventTransactionB: Promise<void> | undefined
      let gateInstalled = false
      const readActivity = (cursor = '0') => pool.query<{ sequence: string; harness_execution_id: string }>(`
        select a.sequence::text,a.harness_execution_id from run_activity a
        where a.run_id='run' and a.kind='harness_output' and a.sequence>$1::bigint
        order by a.sequence limit 1`, [cursor])
      const blockedBy = async (waiter: number, holder: number) => (await pool.query<{ blocked: boolean }>(
        'select $2::integer=any(pg_blocking_pids($1::integer)) as blocked', [waiter, holder])).rows[0]!.blocked
      try {
        // The deferred fixture trigger runs after sequence publication and pauses COMMIT on a separate lock.
        await pool.query(`create function pause_fixture_activity_commit() returns trigger language plpgsql as $$
          begin
            perform pg_advisory_xact_lock(hashtextextended(
              current_schema() || ':fixture_activity_commit:' || NEW.harness_execution_id,0));
            return null;
          end $$;
          create constraint trigger zz_fixture_activity_commit_gate after insert on run_activity
            deferrable initially deferred for each row when (NEW.kind='harness_output')
            execute function pause_fixture_activity_commit()`)
        gateInstalled = true
        gateTransactionA = withTransaction({ client: gateA }, async transaction => {
          await transaction.query(`select pg_advisory_xact_lock(hashtextextended(
            current_schema() || ':fixture_activity_commit:' || $1::text,0))`, ['execution'])
          gateReadyA.resolve((await transaction.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid)
          await releaseGateA.promise
        })
        gateTransactionB = withTransaction({ client: gateB }, async transaction => {
          await transaction.query(`select pg_advisory_xact_lock(hashtextextended(
            current_schema() || ':fixture_activity_commit:' || $1::text,0))`, ['other-execution'])
          gateReadyB.resolve((await transaction.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid)
          await releaseGateB.promise
        })
        const [gatePidA, gatePidB] = await Promise.all([gateReadyA.promise, gateReadyB.promise])
        let pidA = 0, pidB = 0
        eventTransactionA = withTransaction({ client: a }, async transaction => {
          pidA = (await transaction.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
          await appendNativeEvent(transaction, event())
          eventReadyA.resolve()
          await publishA.promise
        })
        eventTransactionB = withTransaction({ client: b }, async transaction => {
          pidB = (await transaction.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
          await appendNativeEvent(transaction, event(0, { executionId: 'other-execution' }))
          eventReadyB.resolve()
          await publishB.promise
        })
        await Promise.all([eventReadyA.promise, eventReadyB.promise])
        expect(await counts(pool)).toEqual({ events: 0, activity: 0 })
        publishA.resolve()
        const firstCommit = eventTransactionA!
        await expect.poll(() => blockedBy(pidA, gatePidA)).toBe(true)
        publishB.resolve()
        const secondCommit = eventTransactionB!
        await expect.poll(() => blockedBy(pidB, pidA)).toBe(true)
        expect((await readActivity()).rows).toEqual([])
        expect(await counts(pool)).toEqual({ events: 0, activity: 0 })

        releaseGateA.resolve()
        await gateTransactionA
        await firstCommit
        await expect.poll(() => blockedBy(pidB, gatePidB)).toBe(true)
        expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
        const firstPage = (await readActivity()).rows
        expect(firstPage).toMatchObject([{ harness_execution_id: 'execution' }])
        const cursor = firstPage[0]!.sequence
        expect((await readActivity(cursor)).rows).toEqual([])

        releaseGateB.resolve()
        await secondCommit
        const secondPage = (await readActivity(cursor)).rows
        expect(secondPage).toMatchObject([{ harness_execution_id: 'other-execution' }])
        expect(BigInt(secondPage[0]!.sequence)).toBeGreaterThan(BigInt(cursor))
        expect((await readActivity(secondPage[0]!.sequence)).rows).toEqual([])
        expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      } finally {
        releaseGateA.resolve(); releaseGateB.resolve(); publishA.resolve(); publishB.resolve()
        await Promise.allSettled([gateTransactionA, gateTransactionB, eventTransactionA, eventTransactionB]
          .filter((value): value is Promise<void> => Boolean(value)))
        a.release()
        b.release()
        gateA.release()
        gateB.release()
        if (gateInstalled) {
          await pool.query(`drop trigger zz_fixture_activity_commit_gate on run_activity;
            drop function pause_fixture_activity_commit()`)
        }
      }
    })
  }, 20_000)

  it('forces concurrent exact replay to remain a no-op after waiting for the first commit', async () => {
    await database(async (pool) => {
      const original = event()
      await forcedRace(pool, original, original)
      expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
      expect(await nextSequence(pool)).toBe('1')
    })
  }, 20_000)

  it('distinguishes connections even when their source sequence restarts at the same value', async () => {
    await database(async (pool) => {
      await forcedRace(pool, event(0), event(0, { connectionId: 'connection-2' }))
      expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
      expect((await pool.query('select sequence from harness_native_events order by sequence')).rows).toEqual([{ sequence: 0 }, { sequence: 1 }])
    })
  }, 20_000)

  it.each(['execution', 'other-execution'] as const)(
    'publishes Activity in commit order across different executions when %s commits first', async firstExecutionId => {
      await database(async (pool) => {
        const a = await pool.connect()
        const b = await pool.connect()
        const firstEvent = event()
        const secondEvent = event(0, { executionId: 'other-execution' })
        const readyA = deferred(), readyB = deferred(), releaseA = deferred(), releaseB = deferred()
        let transactionA: Promise<void> | undefined, transactionB: Promise<void> | undefined
        const readActivity = (cursor = '0') => pool.query<{ sequence: string; harness_execution_id: string }>(`
          select a.sequence::text,a.harness_execution_id from run_activity a
          where a.run_id='run' and a.kind='harness_output' and a.sequence>$1::bigint
          order by a.sequence limit 1`, [cursor])
        try {
          transactionA = withTransaction({ client: a }, async transaction => {
            await appendNativeEvent(transaction, firstEvent)
            readyA.resolve()
            await releaseA.promise
          }, { isolation: 'read committed' })
          transactionB = withTransaction({ client: b }, async transaction => {
            await transaction.query("select set_config('statement_timeout','500ms',true)")
            await appendNativeEvent(transaction, secondEvent)
            readyB.resolve()
            await releaseB.promise
          }, { isolation: 'read committed' })
          await Promise.all([readyA.promise, readyB.promise])
          expect(await counts(pool)).toEqual({ events: 0, activity: 0 })
          expect((await readActivity()).rows).toEqual([])

          const firstCommit = firstExecutionId === 'execution' ? transactionA : transactionB
          const secondCommit = firstExecutionId === 'execution' ? transactionB : transactionA
          const secondExecutionId = firstExecutionId === 'execution' ? 'other-execution' : 'execution'
          if (firstExecutionId === 'execution') releaseA.resolve()
          else releaseB.resolve()
          await firstCommit
          expect(await counts(pool)).toEqual({ events: 1, activity: 1 })
          const firstPage = (await readActivity()).rows
          expect(firstPage).toMatchObject([{ harness_execution_id: firstExecutionId }])
          const cursor = firstPage[0]!.sequence
          expect((await readActivity(cursor)).rows).toEqual([])

          if (firstExecutionId === 'execution') releaseB.resolve()
          else releaseA.resolve()
          await secondCommit
          const secondPage = (await readActivity(cursor)).rows
          expect(secondPage).toMatchObject([{ harness_execution_id: secondExecutionId }])
          expect(BigInt(secondPage[0]!.sequence)).toBeGreaterThan(BigInt(cursor))
          expect(new Set([...firstPage, ...secondPage].map(row => row.sequence)).size).toBe(2)
          expect((await readActivity(secondPage[0]!.sequence)).rows).toEqual([])
          expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
          const events = await pool.query('select execution_id,sequence from harness_native_events order by execution_id')
          expect(events.rows).toEqual([
            { execution_id: 'execution', sequence: 0 },
            { execution_id: 'other-execution', sequence: 0 },
          ])
          await appendNativeEvent(pool, firstEvent)
          await appendNativeEvent(pool, secondEvent)
          expect(await counts(pool)).toEqual({ events: 2, activity: 2 })
          expect((await readActivity(secondPage[0]!.sequence)).rows).toEqual([])
        } finally {
          releaseA.resolve(); releaseB.resolve()
          await Promise.allSettled([transactionA, transactionB].filter((value): value is Promise<void> => Boolean(value)))
          a.release()
          b.release()
        }
      })
  }, 20_000)

  it('does not serialize different executions when native events produce no Activity', async () => {
    await database(async (pool) => {
      const a = await pool.connect()
      const b = await pool.connect()
      const payload = { nativeMethod: 'item/agentMessage/delta', text: 'stream chunk' }
      const firstEntered = deferred(), secondEntered = deferred(), finishFirst = deferred(), finishSecond = deferred()
      let firstTransaction: Promise<void> | undefined, secondTransaction: Promise<void> | undefined
      try {
        firstTransaction = withTransaction({ client: a }, async transaction => {
          await appendNativeEvent(transaction, event(17, { payload }))
          firstEntered.resolve()
          await finishFirst.promise
        })
        secondTransaction = withTransaction({ client: b }, async transaction => {
          await transaction.query("set local lock_timeout='2s'")
          await appendNativeEvent(transaction, event(0, { executionId: 'other-execution', payload }))
          secondEntered.resolve()
          await finishSecond.promise
        })
        await Promise.all([firstEntered.promise, secondEntered.promise])
        finishSecond.resolve()
        await secondTransaction // Must finish while a still owns its execution row.
        expect(await counts(pool)).toEqual({ events: 1, activity: 0 })
        finishFirst.resolve()
        await firstTransaction
        expect(await counts(pool)).toEqual({ events: 2, activity: 0 })
      } finally {
        finishFirst.resolve(); finishSecond.resolve()
        await Promise.allSettled([firstTransaction, secondTransaction].filter((value): value is Promise<void> => Boolean(value)))
        a.release()
        b.release()
      }
    })
  })

})

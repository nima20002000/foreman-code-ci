import { describe, expect, it } from 'vitest'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/connection.js'
import { visitRepeatNativeAttemptsLocked, type RepeatNativeAttemptSelection } from '../src/modules/runs/repeatNativeAttempts.js'
import { postgresEnabled } from './helpers/database.js'
import { disposableDatabase, execution, finishOccurrence, insertExecution, insertOccurrence,
  now, occurrence, seedRun, text, transaction } from './repeat-migration-fixtures.js'

describe.skipIf(!postgresEnabled)('native attempt SQL selection', () => {
  it('bounds technical retries, separates occurrences, includes unmapped work and locks visited executions', async () => {
    await disposableDatabase(async pool => {
      await applyApplicationMigrations(pool)
      const seeded = await transaction(pool, async sql => {
        const run = await seedRun(sql, 'native-attempt-selection')
        const first = occurrence(run)
        await insertOccurrence(sql, first)
        const one = execution(run, first)
        await insertExecution(sql, one)
        await sql.query('update harness_executions set record=$2::jsonb where id=$1', [one.id, text({ ...one.record,
          state: 'completed', finishedAt: now, result: { outcome: 'failed', error: { code: 'RETRY', message: 'retry', retryable: true } } })])
        const retry = execution(run, first, { attempt: 2, previous: one })
        await insertExecution(sql, retry, false)
        const progressed = await finishOccurrence(sql, retry)
        if (!progressed.successor) throw new Error('Expected a second occurrence')
        const second = execution(run, progressed.successor)
        await insertExecution(sql, second)
        const unmapped = execution(run, null)
        await sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
          values($1,$2,$3,$4,1,$5::jsonb)`, [unmapped.id, run.id, unmapped.nodeId, unmapped.record.agentId, text(unmapped.record)])
        return { run, first, one, retry, second, unmapped }
      })
      await withExclusiveGraphConnection(pool, connection => connection.transaction(async sql => {
        const collect = async (selected: RepeatNativeAttemptSelection) => {
          const ids: string[] = []
          await visitRepeatNativeAttemptsLocked(sql, seeded.run.id, selected, async batch => { ids.push(...batch) })
          return ids
        }
        expect(await collect({ kind: 'slot', id: seeded.one.slotId, throughAttempt: 1 })).toEqual([seeded.one.id])
        // The future retry was not selected or locked by the earlier attempt's cleanup.
        await transaction(pool, async other => {
          await other.query("set local lock_timeout='100ms'")
          await other.query('update harness_executions set record=record where id=$1', [seeded.retry.id])
        })
        await expect(transaction(pool, async other => {
          await other.query("set local lock_timeout='100ms'")
          await other.query('update harness_executions set record=record where id=$1', [seeded.one.id])
        })).rejects.toMatchObject({ code: '55P03' })
        expect(await collect({ kind: 'occurrence', id: seeded.first.id })).toEqual([seeded.one.id, seeded.retry.id].sort())
        expect(await collect({ kind: 'run' })).toEqual([seeded.one.id, seeded.retry.id, seeded.second.id, seeded.unmapped.id].sort())
      }))
    })
  })
})

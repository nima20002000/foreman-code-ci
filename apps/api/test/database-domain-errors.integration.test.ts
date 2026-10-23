import { expect, it } from 'vitest'
import { DomainError } from '@foreman-code/contracts-node/server-kit'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { acceptResult, acceptedResult, decision, execution, insertDecision, insertExecution,
  insertOccurrence, insertResolution, occurrence, seedRun } from './repeat-migration-fixtures.js'

it('returns typed repeat conflicts for immediate and deferred database rules and rolls back their writes', async () => {
  const database = await migratedDatabase()
  const client = await database.pool.connect()
  try {
    const run = await withTransaction({ client }, sql => seedRun(sql, 'mapped-repeat-rules'))
    const first = occurrence(run)
    await withTransaction({ client }, sql => insertOccurrence(sql, first))
    const foreign = await withTransaction({ client }, sql => seedRun(sql, 'mapped-foreign-scope'))
    const invalid = occurrence(run, 1, undefined, 'other-block')
    invalid.record.identity.scope.workspaceId = foreign.workspaceId
    await expect(withTransaction({ client }, async sql => {
      await sql.query('set constraints all immediate')
      await insertOccurrence(sql, invalid)
    }))
      .rejects.toMatchObject({ code: 'REPEAT_SCOPE_CONFLICT', status: 409,
        message: 'The repeat operation conflicts with its pinned durable evidence.' })
    expect((await client.query('select count(*)::int as n from run_repeat_occurrences where run_id=$1',
      [run.id])).rows[0]).toEqual({ n: 1 })

    const attempt = execution(run, first)
    const result = acceptedResult('issues')
    const failure = await withTransaction({ client }, async sql => {
      await insertExecution(sql, attempt)
      await acceptResult(sql, attempt, result)
      await insertResolution(sql, attempt, result, false, 'issues')
      await insertDecision(sql, decision(attempt, result, 'issues'))
      // The deferred rule requires this decision's successor before COMMIT.
    }).catch((error: unknown) => error)
    expect(failure).toBeInstanceOf(DomainError)
    expect(failure).toMatchObject({ code: 'REPEAT_SUCCESSOR_MISSING', status: 409,
      cause: { code: 'P0001', message: 'REPEAT_SUCCESSOR_MISSING' } })
    expect((await client.query('select count(*)::int as n from harness_executions where run_id=$1',
      [run.id])).rows[0]).toEqual({ n: 0 })
    expect((await client.query('select count(*)::int as n from run_repeat_decisions')).rows[0]).toEqual({ n: 0 })
  } finally {
    client.release()
    await database.close()
  }
})

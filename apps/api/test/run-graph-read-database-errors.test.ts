import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { RunGraphReadService } from '../src/modules/run-graph/readService.js'
import { currentGraphPrincipal, currentGraphRequest } from './helpers/currentGraphReadUnit.js'
import { ProjectionDatabase } from './eng04-projection-fixture.js'

/** A graph read whose pool fails the first statement matching `failing`, like a saturated or restarted database. */
async function readerFailingOn(failing: RegExp, failure: Error) {
  const db = new ProjectionDatabase()
  await db.initialize()
  const pool = { connect: async () => {
    const client = db.connect()
    const query = client.query.bind(client) as (text: string, values?: unknown[]) => Promise<unknown>
    ;(client as { query: unknown }).query = async (text: string, values?: unknown[]) => {
      if (failing.test(text.replace(/\s+/g, ' ').trim())) throw failure
      return query(text, values)
    }
    return client
  } } as unknown as pg.Pool
  return new RunGraphReadService(pool, { qualifiedReads: true })
}

describe('run graph reads when the database fails', () => {
  it('does not report a database error during authorization as an access denial', async () => {
    const failure = new Error('connection terminated unexpectedly')
    const reads = await readerFailingOn(/^select workspace_id,workflow_id,id from runs where id=\$1$/, failure)
    await expect(reads.current(currentGraphPrincipal(), currentGraphRequest)).rejects
      .not.toMatchObject({ code: 'GRAPH_READ_ACCESS_DENIED' })
  })

  it('still denies a principal without access to the run', async () => {
    const reads = await readerFailingOn(/^never matches$/, new Error('unused'))
    await expect(reads.current(currentGraphPrincipal(false), currentGraphRequest)).rejects
      .toMatchObject({ code: 'GRAPH_READ_ACCESS_DENIED' })
  })

  it('keeps the underlying database error as the cause of the reported failure', async () => {
    const failure = new Error('connection terminated unexpectedly')
    const reads = await readerFailingOn(/from runs r join workflow_versions v/, failure)
    await expect(reads.current(currentGraphPrincipal(), currentGraphRequest)).rejects.toMatchObject({ cause: failure })
  })
})

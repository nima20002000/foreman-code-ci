import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { ExclusiveGraphConnection, beforeGraphCommit } from '../src/modules/run-graph/connection.js'
import type { SqlTransaction } from '../src/infrastructure/transaction.js'
import { beginTransaction, rollbackTransaction } from '../src/infrastructure/transaction.js'
import { RunGraphError } from '../src/modules/run-graph/errors.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { deferred } from './helpers/deferred.js'

let db: Awaited<ReturnType<typeof migratedDatabase>>
beforeEach(async () => {
  db = await migratedDatabase()
  await db.pool.query('create table transaction_probe (id integer primary key)')
})
afterEach(async () => { await db?.close() })

async function fixture(assertOwned = () => {}) {
  const raw = await db.pool.connect()
  const connection = new ExclusiveGraphConnection(raw, assertOwned)
  return { raw, connection, async close() { await connection.close(); raw.release(connection.unusable) } }
}
const persisted = async () => (await db.pool.query('select id from transaction_probe order by id')).rows

describe('exclusive graph transactions against PostgreSQL', () => {
  it('serializes a whole transaction against ordinary owner-client queries', async () => {
    const f = await fixture(), entered = deferred(), release = deferred()
    try {
      const first = f.connection.transaction(async sql => {
        await sql.query('insert into transaction_probe values (1)')
        entered.resolve(); await release.promise
        await sql.query('insert into transaction_probe values (2)')
      })
      await entered.promise
      let ordinaryFinished = false
      const second = f.connection.query('select count(*)::int as count from transaction_probe').then(result => {
        ordinaryFinished = true
        return result.rows[0].count
      })
      expect(await persisted()).toEqual([])
      expect(ordinaryFinished).toBe(false)
      release.resolve()
      await first
      expect(await second).toBe(2)
      expect(await persisted()).toEqual([{ id: 1 }, { id: 2 }])
    } finally { release.resolve(); await f.close() }
  })
  it('rejects duplicate raw-client adoption, nested transactions and manual transaction control', async () => {
    const f = await fixture()
    try {
      expect(() => new ExclusiveGraphConnection(f.raw, () => {})).toThrow('GRAPH_TRANSACTION_CONCURRENT')
      await expect(f.connection.transaction(async () => f.connection.transaction(async () => undefined))).rejects.toThrow('GRAPH_TRANSACTION_NESTED')
      await expect(f.connection.transaction(async sql => { await sql.query('/* no escape */ commit') })).rejects.toThrow('GRAPH_TRANSACTION_NESTED')
      expect(await persisted()).toEqual([])
    } finally { await f.close() }
  })
  it('never lends a transaction port after callback completion', async () => {
    const f = await fixture()
    let escaped!: SqlTransaction
    try {
      await f.connection.transaction(async sql => { escaped = sql })
      await expect(escaped.query('select 1')).rejects.toThrow('GRAPH_TRANSACTION_CLOSED')
    } finally { await f.close() }
  })
  it('poisons and rolls back the transaction after a caught SQL failure', async () => {
    const f = await fixture()
    try {
      await expect(f.connection.transaction(async sql => {
        await sql.query('insert into transaction_probe values (1)')
        await expect(sql.query('insert into transaction_probe values (1)')).rejects.toMatchObject({ code: '23505' })
      })).rejects.toThrow('GRAPH_TRANSACTION_FAILED')
      expect(await persisted()).toEqual([])
    } finally { await f.close() }
  })
  it('rejects concurrent statements rather than interleaving them', async () => {
    const f = await fixture()
    try {
      await expect(f.connection.transaction(async sql => {
        const pending = sql.query('select pg_sleep(0.02)')
        await expect(sql.query('insert into transaction_probe values (1)')).rejects.toThrow('GRAPH_TRANSACTION_CONCURRENT')
        await pending
      })).rejects.toThrow('GRAPH_TRANSACTION_FAILED')
      expect(await persisted()).toEqual([])
    } finally { await f.close() }
  })
  it('finalizes publication before commit and retires an uncertain commit connection', async () => {
    const f = await fixture()
    // A deferred constraint makes PostgreSQL reject COMMIT after the callback
    // and its publication finalizer have both succeeded.
    await db.pool.query('create table deferred_probe (id integer unique deferrable initially deferred)')
    const work = vi.fn(async (sql: SqlTransaction) => {
      await sql.query('insert into transaction_probe values (1)')
      beforeGraphCommit(sql, async () => {
        expect((await sql.query('select id from transaction_probe')).rows).toEqual([{ id: 1 }])
        await sql.query('insert into deferred_probe values (1),(1)')
      })
    })
    try {
      const failure = await f.connection.transaction(work).then(() => undefined, (error: unknown) => error)
      expect(failure).toMatchObject({ code: '23505' })
      expect(f.connection.unusable).toBe(true)
      await expect(f.connection.query('select 1')).rejects.toMatchObject({ cause: failure })
      expect(work).toHaveBeenCalledOnce()
      expect(await persisted()).toEqual([])
    } finally { await f.close() }
  })
  it('checks singleton-owner liveness and does not confer ownership itself', async () => {
    let owned = true
    const f = await fixture(() => { if (!owned) throw new RunGraphError('GRAPH_OWNER_LOST') })
    try {
      await expect(f.connection.transaction(async sql => {
        await sql.query('insert into transaction_probe values (1)')
        owned = false
      })).rejects.toThrow('GRAPH_OWNER_LOST')
      expect(await persisted()).toEqual([])
    } finally { await f.close() }
  })
  it('rejects an already-open outer transaction when the driver exposes transaction status', async () => {
    const f = await fixture()
    try {
      await beginTransaction(f.raw)
      await f.raw.query('insert into transaction_probe values (1)')
      Object.assign(f.raw, { getTransactionStatus: () => 'T' })
      await expect(f.connection.transaction(async () => undefined)).rejects.toThrow('GRAPH_TRANSACTION_NESTED')
      expect((await f.raw.query('select id from transaction_probe')).rows).toEqual([{ id: 1 }])
      await rollbackTransaction(f.raw)
      expect(await persisted()).toEqual([])
    } finally { await f.close() }
  })
})

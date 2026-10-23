import type pg from 'pg'
import { beforeEach, expect, it, vi } from 'vitest'
import { componentLogger } from './logger.js'
import { ExclusiveGraphConnection, beforeGraphCommit } from '../modules/run-graph/connection.js'
import { beginTransaction, commitTransaction, withTransaction } from './transaction.js'
import { DomainError } from '@foreman-code/contracts/server-kit'

vi.mock('./logger.js', () => {
  const log = { info: vi.fn(), warn: vi.fn(), error: vi.fn() }
  return { componentLogger: () => log }
})
beforeEach(() => vi.clearAllMocks())

function fixture(failures: Record<number, Error> = {}) {
  let statements = 0
  const query = vi.fn(async () => {
    statements += 1
    if (failures[statements]) throw failures[statements]
    return { rows: [], rowCount: 0, command: '', oid: 0, fields: [] }
  })
  const release = vi.fn()
  const client = { query, release } as unknown as pg.PoolClient
  return { client, query, release, pool: { connect: async () => client }, statements: () => statements }
}

function reports() {
  return vi.mocked(componentLogger('db').info).mock.calls.map(([fields]) => fields)
}

it.each([2, 3])('maps a database rule failure at statement %i after rollback and restores the connection', async statement => {
  const cause = Object.assign(new Error('REPEAT_SCOPE_CONFLICT'), { code: 'P0001' })
  const f = fixture({ [statement]: cause })
  const failure = await withTransaction(f.pool, async client => { await client.query('select 1') })
    .catch((error: unknown) => error)
  expect(failure).toBeInstanceOf(DomainError)
  expect(failure).toMatchObject({ code: 'REPEAT_SCOPE_CONFLICT', status: 409,
    message: 'The repeat operation conflicts with its pinned durable evidence.', cause })
  expect(reports()).toEqual([{ metric: 'db_transaction_statements', operation: 'transaction',
    outcome: 'rolled_back', statements: statement + 1 }])
  expect(f.release).toHaveBeenCalledOnce()
  await expectClientRestored(f)
})

async function expectClientRestored(f: ReturnType<typeof fixture>) {
  const response = Promise.resolve({ rows: [], rowCount: 0, command: '', oid: 0, fields: [] })
  f.query.mockReturnValueOnce(response)
  // Outside a transaction, queries return the driver's result without an instrumentation wrapper.
  const result = f.client.query('select 1')
  expect(result).toBe(response)
  await result
}

it('reports short pooled transactions including transaction control and restores the client', async () => {
  const f = fixture()
  expect(await withTransaction(f.pool, async client => {
    await client.query('select 1')
    return 'saved'
  })).toBe('saved')
  expect(f.statements()).toBeLessThanOrEqual(3)
  expect(reports()).toEqual([{ metric: 'db_transaction_statements', operation: 'transaction',
    outcome: 'committed', statements: 3 }])
  await expectClientRestored(f)
  expect(f.release).toHaveBeenCalledOnce()
})

it('reports caller-owned and manually controlled transactions', async () => {
  const f = fixture()
  await withTransaction({ client: f.client }, async client => { await client.query('select 1') })
  await beginTransaction(f.client)
  await f.client.query('select 1')
  await commitTransaction(f.client)
  expect(reports()).toEqual(Array.from({ length: 2 }, () => ({ metric: 'db_transaction_statements',
    operation: 'transaction', outcome: 'committed', statements: 3 })))
  expect(f.release).not.toHaveBeenCalled()
})

it('runs joined work inside the caller transaction without its own transaction control', async () => {
  const f = fixture()
  const connect = vi.fn(f.pool.connect)
  expect(await withTransaction({ connect }, async client => {
    await client.query('select 1')
    return client
  }, { join: f.client })).toBe(f.client)
  expect(f.statements()).toBe(1)
  expect(connect).not.toHaveBeenCalled()
  expect(reports()).toEqual([])
})

it('leaves joined rule errors raw until the owning transaction rolls back', async () => {
  const cause = Object.assign(new Error('REPEAT_SCOPE_CONFLICT'), { code: 'P0001' })
  const f = fixture({ 2: cause })
  await expect(withTransaction(f.pool, async client => {
    await expect(withTransaction(f.pool, async joined => { await joined.query('select 1') },
      { join: client })).rejects.toBe(cause)
    throw cause
  })).rejects.toMatchObject({ code: 'REPEAT_SCOPE_CONFLICT', status: 409, cause })
  await expectClientRestored(f)
})

it('maps graph rule failures after recovery and lets the owner start another transaction', async () => {
  const cause = Object.assign(new Error('REPEAT_SCOPE_CONFLICT'), { code: 'P0001' })
  const f = fixture({ 2: cause })
  const connection = new ExclusiveGraphConnection(f.client, () => {})
  try {
    await expect(connection.transaction(async sql => { await sql.query('select 1') }))
      .rejects.toMatchObject({ code: 'REPEAT_SCOPE_CONFLICT', status: 409, cause })
    expect(await connection.transaction(async sql => { await sql.query('select 1'); return 'recovered' }))
      .toBe('recovered')
    expect(connection.unusable).toBe(false)
  } finally { await connection.close() }
})

it('starts its own pooled transaction when there is no caller transaction to join', async () => {
  const f = fixture()
  await withTransaction(f.pool, async client => { await client.query('select 1') }, { join: undefined })
  expect(reports()).toEqual([{ metric: 'db_transaction_statements', operation: 'transaction',
    outcome: 'committed', statements: 3 }])
  expect(f.release).toHaveBeenCalledOnce()
})

it('keeps a caller-owned connection after rolling back failed work', async () => {
  const f = fixture()
  const failure = new Error('work failed')
  await expect(withTransaction({ client: f.client }, async client => {
    await client.query('select 1')
    throw failure
  })).rejects.toBe(failure)
  expect(reports()).toEqual([{ metric: 'db_transaction_statements', operation: 'transaction',
    outcome: 'rolled_back', statements: 3 }])
  expect(f.release).not.toHaveBeenCalled()
  await expectClientRestored(f)
})

it('counts graph work and live finalizers once along with transaction controls', async () => {
  const f = fixture()
  const connection = new ExclusiveGraphConnection(f.client, () => {})
  try {
    await connection.transaction(async sql => {
      await sql.query('select 1')
      beforeGraphCommit(sql, async () => { await sql.query('select 1') })
    })
    expect(f.statements()).toBeLessThanOrEqual(4)
    expect(reports()).toEqual([{ metric: 'db_transaction_statements', operation: 'graph.write',
      outcome: 'committed', statements: 4 }])
  } finally { await connection.close() }
})

it('reports a graph finalizer denial and read-only transaction with bounded labels', async () => {
  const f = fixture()
  const connection = new ExclusiveGraphConnection(f.client, () => {})
  const denied = new Error('authority changed')
  try {
    await expect(connection.transaction(async sql => {
      await sql.query('select 1')
      beforeGraphCommit(sql, async () => { throw denied })
    })).rejects.toBe(denied)
    await connection.transaction(async sql => { await sql.query('select 1') }, true)
    expect(reports()).toEqual([
      { metric: 'db_transaction_statements', operation: 'graph.write', outcome: 'rolled_back', statements: 3 },
      { metric: 'db_transaction_statements', operation: 'graph.read', outcome: 'committed', statements: 3 },
    ])
  } finally { await connection.close() }
})

it('reports every conflict attempt including the failed statement and rollback', async () => {
  const conflict = Object.assign(new Error('serialization conflict'), { code: '40001' })
  const f = fixture({ 2: conflict })
  await withTransaction(f.pool, async client => { await client.query('select 1') }, { conflictRetries: 1 })
  expect(reports()).toEqual([
    { metric: 'db_transaction_statements', operation: 'transaction', outcome: 'rolled_back', statements: 3 },
    { metric: 'db_transaction_statements', operation: 'transaction', outcome: 'committed', statements: 3 },
  ])
  await expectClientRestored(f)
})

it('reports a graph transaction when closing prevents rollback recovery', async () => {
  const f = fixture()
  const connection = new ExclusiveGraphConnection(f.client, () => {})
  const failure = new Error('connection closing')
  let closing: Promise<void> | undefined
  try {
    await expect(connection.transaction(async sql => {
      await sql.query('select 1')
      closing = connection.close()
      throw failure
    })).rejects.toBe(failure)
    expect(reports()).toEqual([{ metric: 'db_transaction_statements', operation: 'graph.write',
      outcome: 'failed', statements: 2 }])
    await expectClientRestored(f)
  } finally { await (closing ?? connection.close()) }
})

it.each(['begin', 'commit', 'rollback'] as const)('reports a failed %s without replacing the work error', async stage => {
  const failure = new Error('database failure')
  const f = fixture({ [stage === 'begin' ? 1 : 3]: failure })
  const workFailure = new Error('work failed')
  await expect(withTransaction({ client: f.client }, async () => {
    await f.client.query('select 1')
    if (stage === 'rollback') throw workFailure
  })).rejects.toBe(stage === 'rollback' ? workFailure : failure)
  expect(reports()).toEqual([{ metric: 'db_transaction_statements', operation: 'transaction',
    outcome: stage === 'commit' ? 'rolled_back' : 'failed',
    statements: stage === 'begin' ? 1 : stage === 'commit' ? 4 : 3 }])
  await expectClientRestored(f)
})

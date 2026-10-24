import { afterEach, expect, it, vi } from 'vitest'
import { randomUUID } from 'node:crypto'
import { reconcileFailedCaptures } from '../src/modules/sources/failedCaptureCleanup.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

const databases: Awaited<ReturnType<typeof migratedDatabase>>[] = []
afterEach(async () => { await Promise.all(databases.splice(0).map(database => database.close())) })

async function fixture() {
  const database = await migratedDatabase()
  databases.push(database)
  const pool = database.pool
  const workspaceId = randomUUID()
  await pool.query('insert into workspaces(id,record) values($1,$2::jsonb)',
    [workspaceId, JSON.stringify({ id: workspaceId, name: 'Capture workspace' })])
  const { principal } = await new PostgresAccessService(pool).issue({ name: 'Capture owner', audience: 'operator',
    grants: [{ actions: ['source_roots:bind', 'sources:read', 'workspace_locations:read'], scope: {} }],
    expiresAt: new Date(Date.now() + 60_000) })
  const snapshotId = randomUUID()
  const reservation = { reservationId: randomUUID(), scopeId: 'scope', ownerKind: 'capture', ownerId: snapshotId,
    reservedBytes: 170_000_000 }
  const commandId = randomUUID()
  await pool.query(`insert into source_storage_reservations(reservation_id,scope_id,owner_kind,owner_id,reserved_bytes,state,record)
    values($1,$2,'capture',$3,$4,'uncertain',$5::jsonb)`, [reservation.reservationId, reservation.scopeId,
    snapshotId, reservation.reservedBytes, JSON.stringify(reservation)])
  await pool.query(`insert into source_approvals(approved_source_id,snapshot_id,workspace_id,owner_principal_id,
    requested_by,command_id,input_hash,state,origin,request) values($1,$2,$3,$4,$4,$5,'hash','failed',$6::jsonb,'{}')`,
  [randomUUID(), snapshotId, workspaceId, principal.id, commandId, JSON.stringify({ reservation })])
  const commandLock = `command:${principal.id}:source.approve:${commandId}`
  // Reserve another physical session to probe the production command's session lock.
  const observer = await pool.connect()
  const close = database.close.bind(database)
  database.close = async () => { observer.release(); await close() }
  const commandOwned = async () => {
    const acquired = (await observer.query('select pg_try_advisory_lock(hashtext($1)) as locked', [commandLock])).rows[0]!.locked
    if (acquired) await observer.query('select pg_advisory_unlock(hashtext($1))', [commandLock])
    return !acquired
  }
  const state = async () => (await pool.query(`select a.state as "approvalState",r.state as "reservationState",
    r.reserved_bytes::int as "accountedBytes" from source_approvals a join source_storage_reservations r
    on r.owner_id=a.snapshot_id::text where a.snapshot_id=$1`, [snapshotId])).rows[0]!
  const store = {
    retainedCaptureBytes: vi.fn(async () => { expect(await commandOwned()).toBe(true); return 8192 }),
    withCaptureLock: async <T>(_snapshotId: string, work: () => Promise<T>): Promise<T> => work(),
    remove: vi.fn(async () => { expect(await commandOwned()).toBe(true) }),
    manifest: vi.fn(async (): Promise<never> => {
      throw Object.assign(new Error('Capture not finalized'), { code: 'ENOENT' })
    }),
  }
  const withCaptureLock = vi.spyOn(store, 'withCaptureLock')
  const report = vi.fn()
  return { pool, state, snapshotId, commandLock, observer, commandOwned, store, withCaptureLock, report,
    interrupt: async () => {
      await pool.query("update source_approvals set state='capturing' where snapshot_id=$1", [snapshotId])
      await pool.query("update source_storage_reservations set state='preparing' where reservation_id=$1", [reservation.reservationId])
    },
    expire: () => pool.query("update source_approvals set created_at=now()-interval '400 days' where snapshot_id=$1", [snapshotId]),
  }
}

it('corrects a failed capture reservation under its original command lock and retains metadata', async () => {
  const f = await fixture()
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect(f.store.retainedCaptureBytes).toHaveBeenCalledExactlyOnceWith(f.snapshotId)
  expect(await f.state()).toMatchObject({ reservationState: 'retained', accountedBytes: 24_576 })
  expect(f.report).not.toHaveBeenCalled()
  expect(await f.commandOwned()).toBe(false)
})

it('keeps the full reservation while the original capture command still owns its lock', async () => {
  const f = await fixture()
  await f.observer.query('select pg_advisory_lock(hashtext($1))', [f.commandLock])
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect(f.withCaptureLock).not.toHaveBeenCalled()
  expect(f.store.retainedCaptureBytes).not.toHaveBeenCalled()
  expect((await f.state()).accountedBytes).toBe(170_000_000)
  await f.observer.query('select pg_advisory_unlock(hashtext($1))', [f.commandLock])
})

it('keeps the reservation and reports failed physical accounting', async () => {
  const f = await fixture()
  f.store.retainedCaptureBytes.mockRejectedValue(new Error('unsafe retained file'))
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect((await f.state()).reservationState).toBe('uncertain')
  expect((await f.state()).accountedBytes).toBe(170_000_000)
  expect(f.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'unsafe retained file' }))
  expect(await f.commandOwned()).toBe(false)
})

it('keeps an interrupted capture fully charged while a filesystem writer still owns it', async () => {
  const f = await fixture()
  await f.interrupt()
  f.withCaptureLock.mockRejectedValueOnce(Object.assign(new Error('Live capture writer'),
    { code: 'SOURCE_CLAIM_LOCK_FAILED' }))
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect(f.store.manifest).not.toHaveBeenCalled()
  expect(f.store.retainedCaptureBytes).not.toHaveBeenCalled()
  expect(await f.state()).toMatchObject({ reservationState: 'preparing', accountedBytes: 170_000_000 })
  expect(f.report).not.toHaveBeenCalled()
  expect(await f.commandOwned()).toBe(false)
})

it('frees an abandoned partial capture slot even while its original caller remains authorized', async () => {
  const f = await fixture()
  await f.interrupt()
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect(await f.state()).toMatchObject({ approvalState: 'failed', reservationState: 'retained', accountedBytes: 24_576 })
  expect(f.store.remove).not.toHaveBeenCalled()
  expect(f.report).not.toHaveBeenCalled()
})

it('reclaims expired failed capture bytes only after physical removal succeeds', async () => {
  const f = await fixture()
  await f.expire()
  f.store.remove.mockRejectedValueOnce(new Error('Removal interrupted'))
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect((await f.state()).reservationState).toBe('retained')
  expect(f.report).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ message: 'Removal interrupted' }))
  expect(await f.commandOwned()).toBe(false)
  f.report.mockClear()
  await reconcileFailedCaptures(f.pool, f.store, f.report)
  expect((await f.state()).reservationState).toBe('reclaimed')
  expect(f.store.remove).toHaveBeenCalledTimes(2)
  expect(f.report).not.toHaveBeenCalled()
  expect(await f.commandOwned()).toBe(false)
})

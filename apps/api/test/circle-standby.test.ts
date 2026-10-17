import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'
import { claimCiSlot } from '../src/modules/ci-host/cloudSlots.js'
import { CircleStandby } from '../src/modules/ci-host/circleStandby.js'
import { CircleCreditCache } from '../src/modules/ci-host/circleCreditCache.js'
import type { HostCiComputer } from '../src/modules/ci-host/serviceTypes.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { CircleAccountsManagementService } from '../src/modules/settings/circleAccounts.js'
import { PostgresFoundationSettingsRepository } from '../src/modules/settings/foundation.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { withTransaction } from '../src/infrastructure/transaction.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

const slot = (mainId: string, owner?: string, circleAccountId?: string): HostCiComputer => ({
  key: `${mainId}:cloud:circleci${circleAccountId ? `~${circleAccountId}` : ''}${owner ? `@${owner}` : ''}:0`,
  hostRef: { kind: 'cloud', mainId, provider: 'circleci', slot: 0,
    ...(owner ? { account: owner } : {}), ...(circleAccountId ? { circleAccountId } : {}) },
  label: 'Fixture CircleCI', priority: 30,
})
async function ticket(workspaceId: string, computer?: HostCiComputer): Promise<CiRunRecord> {
  const id = randomUUID()
  const run = CiRunRecordSchema.parse({ id, workspaceId, groupId: randomUUID(), suite: 'lint',
    commit: 'a'.repeat(40), repository: 'fixture/site', ciMirror: 'alpha/site-ci', partition: null,
    state: computer ? 'running' : 'queued', computer: computer ? { hostRef: computer.hostRef, label: computer.label } : null,
    step: null, exitCode: null, message: null, queuedAt: new Date().toISOString(),
    startedAt: computer ? new Date().toISOString() : null, finishedAt: null,
    initiator: { principalId: 'fixture-principal', executionId: null },
  })
  await database.pool.query('insert into ci_runs(id,workspace_id,group_id,state,host_key,record) values($1,$2,$3,$4,$5,$6)',
    [id, workspaceId, run.groupId, run.state, computer?.key ?? null, JSON.stringify(run)])
  return run
}
async function workspace() {
  const id = randomUUID()
  await database.pool.query('insert into workspaces(id,record) values($1,$2)', [id, JSON.stringify({ id,
    name: 'Fixture workspace', repository: { provider: 'github', owner: 'fixture', name: 'site', defaultBranch: 'main' },
  })])
  return id
}
const request = (run: CiRunRecord) => ({ operation: 'start' as const, runId: run.id, workspaceId: run.workspaceId,
  repository: run.repository, ciMirror: run.ciMirror!, commit: run.commit, suite: run.suite, scope: run.scope })

it.each([false, true])('counts legacy and explicit primary aliases as the same physical org slot, legacy first: %s', async legacyFirst => {
  const workspaceId = await workspace()
  const mainId = randomUUID()
  const legacy = slot(mainId)
  const named = slot(mainId, 'alpha')
  const occupied = await ticket(workspaceId, legacyFirst ? legacy : named)
  const queued = await ticket(workspaceId)
  expect(await claimCiSlot(database.pool, queued, legacyFirst ? named : legacy, request(queued))).toBe('busy')
  const rows = (await database.pool.query('select host_key,record from ci_runs where id=$1', [occupied.id])).rows
  expect(rows[0]).toMatchObject({ host_key: occupied.computer ? (legacyFirst ? legacy.key : named.key) : null,
    record: occupied })
})

it('serializes concurrent alias claims and preserves the chosen login in saved records after reconstruction', async () => {
  const workspaceId = await workspace()
  const mainId = randomUUID()
  const first = await ticket(workspaceId)
  const second = await ticket(workspaceId)
  const results = await Promise.all([
    claimCiSlot(database.pool, first, slot(mainId), request(first)),
    claimCiSlot(database.pool, second, slot(mainId, 'alpha'), request(second)),
  ])
  expect(results.filter(result => result === 'busy')).toHaveLength(1)
  expect(results.filter(result => result && result !== 'busy')).toHaveLength(1)
  const reserve = await ticket(workspaceId)
  const reserveSlot = slot(mainId, 'delta', 'reserve')
  expect(await claimCiSlot(database.pool, reserve, reserveSlot, request(reserve)))
    .toMatchObject({ computer: { hostRef: reserveSlot.hostRef } })
  const saved = (await database.pool.query('select host_key,record from ci_runs where id=$1', [reserve.id])).rows[0]!
  expect(saved.host_key).toBe(reserveSlot.key)
  expect(CiRunRecordSchema.parse(saved.record).computer?.hostRef).toEqual(reserveSlot.hostRef)
})

it('shares the threshold and UTC reset policy used by planning and new-start checks', async () => {
  let now = Date.parse('2026-10-31T23:59:59Z')
  let remaining = 20_000
  const cache = new CircleCreditCache()
  const selector = new CircleStandby(async () => [
    { owner: 'alpha', circleAccountId: 'default', role: 'primary', ready: true, mirrorNames: new Set(['site-ci']) },
    { owner: 'delta', circleAccountId: 'reserve', role: 'standby', ready: true, mirrorNames: new Set(['site-ci']) },
  ], { reading: async (owner?: string) => now >= Date.parse('2026-11-01T00:00:00Z') ? { credits: null }
    : { credits: { total: 400_000, used: 400_000 - (owner === 'alpha' ? remaining : 400_000),
      remaining: owner === 'alpha' ? remaining : 400_000, asOf: new Date(now).toISOString() } } }, cache, () => now)
  expect(await selector.eligible('alpha', 'default', 'site-ci')).toBe(false)
  expect(await selector.eligible('delta', 'reserve', 'site-ci')).toBe(true)
  remaining = 20_001
  expect(await selector.eligible('alpha', 'default', 'site-ci')).toBe(true)
  expect(await selector.eligible('delta', 'reserve', 'site-ci')).toBe(false)
  remaining = 0
  await selector.roles('site-ci')
  now += 1000
  expect(await selector.eligible('alpha', 'default', 'site-ci')).toBe(true)
  expect(await selector.eligible('delta', 'reserve', 'site-ci')).toBe(false)
})

it('cannot claim a stale standby row after its registration has been removed', async () => {
  const access = new PostgresAccessService(database.pool)
  const caller = await access.issue({ name: 'Fixture Operator', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['settings:read', 'settings:update'], scope: {} }] })
  const settings = new PostgresFoundationSettingsRepository(database.pool)
  const service = new CircleAccountsManagementService(settings, new PostgresCommandCoordinator(database.pool), {
    read: async account => ({ tokenConfigured: false, ready: false, reasons: ['Setup needed.'],
      orgs: account.organizations.map(owner => ({ account: owner, circleAccountId: account.id, ready: false,
        running: 0, schedulingRole: 'standby', schedulingReason: 'Setup needed.', credits: null })) }),
  })
  await service.add(caller.principal, 'mcp', { account: {
    id: 'spare', label: 'Spare', role: 'standby', organizations: ['eta', 'theta', 'iota'],
  } })
  await service.remove(caller.principal, 'mcp', { id: 'spare' })
  const queued = await ticket(await workspace())
  expect(await claimCiSlot(database.pool, queued, slot(randomUUID(), 'eta', 'spare'), request(queued))).toBeNull()
  expect((await database.pool.query('select record from ci_runs where id=$1', [queued.id])).rows[0]!.record.state).toBe('queued')
})

it('serializes removal and claims so either removal is refused or the stale claim cannot assign work', async () => {
  const settings = new PostgresFoundationSettingsRepository(database.pool)
  const workspaceId = await workspace()
  const queued = await ticket(workspaceId)
  await withTransaction(database.pool, async client => {
    await settings.updateCircleAccounts({ accounts: [
      { id: 'default', label: 'Primary', role: 'primary', organizations: [] },
      { id: 'spare', label: 'Spare', role: 'standby', organizations: ['eta', 'theta', 'iota'] },
    ] }, undefined, client)
  })
  let release!: () => void
  let entered!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  const locked = new Promise<void>(resolve => { entered = resolve })
  const removal = withTransaction(database.pool, async client => {
    await client.query('select pg_advisory_xact_lock(hashtext($1))', ['circle-accounts'])
    entered()
    await held
    await settings.updateCircleAccounts({ accounts: [
      { id: 'default', label: 'Primary', role: 'primary', organizations: [] },
    ] }, undefined, client)
  })
  await locked
  const claim = claimCiSlot(database.pool, queued, slot(randomUUID(), 'eta', 'spare'), request(queued))
  release()
  await removal
  expect(await claim).toBeNull()
})

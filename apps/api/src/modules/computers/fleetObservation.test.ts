import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ComputerMaintenance } from './maintenance.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { PostgresAccessService } from '../access/postgres.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { buildApp } from '../../app.js'
import { FleetMaintenanceService } from './fleet.js'
import { fakeComputer, fakeFleet } from '../../../test/helpers/fleetSync.js'

it.each(['workerManifestSha256s', 'workerContentSha256s'] as const)(
  'rejects empty configured %s inventory instead of skipping convergence', async method => {
    const fixture = fakeFleet(fakeComputer())
    fixture.sources[method] = async () => []
    await expect(fixture.fleet.syncChangedSources()).rejects.toMatchObject({ code: 'WORKER_BUNDLE_UNPUBLISHED' })
    expect(fixture.requested).toEqual([])
    await fixture.fleet.drain()
  })

it.each(['workerManifestSha256s', 'workerContentSha256s'] as const)(
  'rejects failed configured %s inventory instead of claiming there are no updates', async method => {
    const fixture = fakeFleet(fakeComputer())
    fixture.sources[method] = async () => { throw new Error('Artifact inventory unavailable.') }
    await expect(fixture.fleet.syncChangedSources()).rejects.toThrow('Artifact inventory unavailable.')
    expect(fixture.requested).toEqual([])
    await fixture.fleet.drain()
  })

it('allows an unsupported optional inventory without inventing an inventory failure', async () => {
  const fixture = fakeFleet(fakeComputer())
  await expect(fixture.fleet.syncChangedSources()).resolves.toBeUndefined()
  await fixture.fleet.drain()
})

function fixture() {
  const mainId = randomUUID()
  const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00Z', revokedAt: null,
    grants: [{ actions: ['settings:read', 'capabilities:read'], scope: {} }] }
  const query = vi.fn(async (_text: string, values: unknown[]) => ({ rows: values?.[0] === principal.id
    ? [{ ...principal, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }] : [] }))
  const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const commands = { recordDenied: vi.fn(async () => undefined) } as unknown as PostgresCommandCoordinator
  const status = { observedAt: '2026-10-14T00:00:00Z', harnesses: [], tasks: [],
    system: { packageUpdates: null, rebootRequired: false, sudo: false, disk: null } }
  const probe = vi.fn(async () => status)
  let now = Date.parse(status.observedAt)
  const fleet = new FleetMaintenanceService(pool, mainId, () => undefined, commands,
    { status: probe, drain: async () => {} } as unknown as ComputerMaintenance, {
      codexUserMcpServers: async () => ({}), claudeUserMcpServers: async () => ({}),
      codexPlugins: async () => [], codexMarketplaces: async () => [],
      claudePlugins: async () => ({ plugins: [], marketplaces: [] }),
    }, () => now)
  return { fleet, principal, commands, status, probe, target: { hostRef: { kind: 'main', mainId },
    applicationInstallationId: mainId, keyRevision: null, authorizationRevision: null }, advance: () => { now += 1000 } }
}

it.each(['fleet', 'target'] as const)('reports failed %s observations beside the last good status, retries ordinary reads and clears the failure after success', async kind => {
  const f = fixture()
  const read = (refresh = false) => kind === 'fleet' ? f.fleet.list(f.principal, 'http', refresh)
    : f.fleet.readTarget(f.principal, 'http', { target: f.target, refresh })
  await read()
  f.advance()
  f.probe.mockRejectedValue(Object.assign(new Error('secret transport details'), { code: 'DEVICE_TRANSPORT_ERROR' }))
  const failed = await read(true)
  expect(failed.computers[0]).toMatchObject({ status: f.status, observation: {
    status: 'unavailable', lastError: expect.stringContaining('DEVICE_TRANSPORT_ERROR'),
    failedAt: '2026-10-14T00:00:01.000Z', lastSuccess: '2026-10-14T00:00:00.000Z', consecutiveFailures: 1,
  } })
  expect(JSON.stringify(failed)).not.toContain('secret transport details')
  const retried = await read()
  expect(retried.computers[0]).toMatchObject({ observation: { consecutiveFailures: 2 } })
  expect(f.probe).toHaveBeenCalledTimes(3)
  f.probe.mockResolvedValue(f.status)
  expect((await read()).computers[0]).toMatchObject({ status: f.status, observation: {
    status: 'available', lastError: null, failedAt: null, consecutiveFailures: 0,
  } })
  await f.fleet.drain()
})

it.each(['fleet', 'target'] as const)('returns %s maintenance failure observations through authenticated HTTP and denies an unauthorized caller', async kind => {
  const f = fixture()
  f.probe.mockRejectedValue(Object.assign(new Error('private transport data'), { code: 'DEVICE_TRANSPORT_ERROR' }))
  const access = { authenticate: async (token: string) => token === 'reader'
    ? f.principal : { ...f.principal, id: 'denied', grants: [] } } as unknown as PostgresAccessService
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands: f.commands, computerMaintenance: f.fleet } as unknown as OperatorServices } })
  const read = (token: string) => kind === 'target'
    ? app.inject({ method: 'POST', url: '/api/management/computers/maintenance/read',
      headers: { authorization: `Bearer ${token}` }, payload: { target: f.target } })
    : app.inject({ method: 'GET', url: '/api/management/computers/maintenance',
      headers: { authorization: `Bearer ${token}` } })
  try {
    const result = await read('reader')
    expect(result.statusCode).toBe(200)
    expect(result.json()).toMatchObject({ computers: [{ status: null,
      observation: { status: 'unavailable', consecutiveFailures: 1,
        lastError: expect.stringContaining('DEVICE_TRANSPORT_ERROR') } }] })
    expect((await read('denied')).statusCode).toBe(403)
    expect(f.probe).toHaveBeenCalledOnce()
    f.probe.mockResolvedValue(f.status)
    const recovered = await read('reader')
    expect(recovered.json()).toMatchObject({ computers: [{ status: f.status,
      observation: { status: 'available', lastError: null, consecutiveFailures: 0 } }] })
  } finally {
    await app.close()
    await f.fleet.drain()
  }
})

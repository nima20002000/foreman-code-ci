import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import type { PostgresAccessService } from '../access/postgres.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { ComputerMaintenance } from './maintenance.js'
import { FleetMaintenanceService, type FleetSources } from './fleet.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { workerBundleFixture } from '../../../test/support/workerBundle.js'

it('reads bundle skew and persisted publication errors through authenticated HTTP and denies an unauthorized reader', async () => {
  const f = await workerBundleFixture()
  const principal: ManagementPrincipal = { id: randomUUID(), name: 'Reader', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['settings:read', 'capabilities:read'], scope: {} }] }
  const registration = { mainId: f.identity.mainId, deviceId: f.identity.deviceId,
    workerInstallationId: f.identity.workerInstallationId, keyRevision: 1, authorizationRevision: 1,
    publicKeyFingerprint: 'a'.repeat(64), status: 'paired', scopes: ['connect', 'heartbeat'] }
  const query = vi.fn(async (_query: unknown, values: unknown[]) => ({ rows: values[0] === principal.id
    ? [{ ...principal, expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null }]
    : [{ record: registration }] }))
  const pool = { connect: async () => ({ query, release() {} }) } as unknown as pg.Pool
  const commands = { recordDenied: vi.fn() } as unknown as PostgresCommandCoordinator
  const fleet = new FleetMaintenanceService(pool, f.identity.mainId, () => f.endpoint, commands,
    { drain: async () => {} } as ComputerMaintenance, {} as FleetSources)
  const access = { authenticate: async (token: string) => token === 'reader' ? principal
    : { ...principal, id: randomUUID(), grants: [] } } as unknown as PostgresAccessService
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, computerMaintenance: fleet } as unknown as OperatorServices },
  })
  const target = { hostRef: { kind: 'device', mainId: f.identity.mainId, deviceId: f.identity.deviceId },
    applicationInstallationId: f.identity.workerInstallationId, keyRevision: 1, authorizationRevision: 1 }
  try {
    const read = (token = 'reader') => app.inject({ method: 'POST', url: '/api/management/computers/maintenance/read',
      headers: { authorization: `Bearer ${token}` }, payload: { target, refresh: true } })
    const result = await read()
    expect(result.statusCode).toBe(200)
    expect(result.json()).toMatchObject({ computers: [{ workerReadiness: {
      ready: false, code: 'WORKER_VERSION_SKEW', expected: f.expected,
      running: { manifestSha256: f.status.worker.manifestSha256 }, updatePhase: 'current',
    } }] })
    expect((await read('denied')).statusCode).toBe(403)
    f.index.publication = { state: 'failed', lastError: 'Release asset missing' }
    await f.publish()
    expect((await read()).json()).toMatchObject({ computers: [{ workerReadiness: {
      ready: false, code: 'WORKER_BUNDLE_UNPUBLISHED', publicationError: 'Release asset missing',
    } }] })
    f.index.publication = { state: 'published', lastError: null }
    await f.publish()
    f.match()
    expect((await read()).json()).toMatchObject({ computers: [{ workerReadiness: {
      ready: true, code: null, expected: f.expected, updatePhase: 'current',
    } }] })
  } finally {
    await app.close()
    await fleet.drain()
    await f.close()
  }
})

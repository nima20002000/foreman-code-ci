import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import { fakeComputer } from '../../../test/helpers/fleetSync.js'
import { buildApp } from '../../app.js'
import { PostgresAccessService } from '../access/postgres.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import { registerService, trackService } from '../diagnostics/serviceHealth.js'
import type { OperatorServices } from '../../mcp/operator/types.js'
import { ComputerMaintenance } from './maintenance.js'
import { FleetMaintenanceService, type FleetSources } from './fleet.js'
import { readWorkerReleasePublication } from './workerArtifacts.js'

it('reads stalled background loops and an overdue Worker publication through authenticated HTTP', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'service-health-'))
  const principal: ManagementPrincipal = { id: randomUUID(), name: 'Reader', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['settings:read', 'capabilities:read'], scope: {} }] }
  const denied: ManagementPrincipal = { ...principal, id: randomUUID(), grants: [{ actions: ['capabilities:read'], scope: {} }] }
  // The publication unit died three hours ago without recording a result.
  const startedAt = new Date(Date.now() - 3 * 60 * 60_000).toISOString()
  const deadlineAt = new Date(Date.now() - 60 * 60_000).toISOString()
  await writeFile(join(directory, 'index.json'), JSON.stringify({ format: 1, version: '1.1.0', artifacts: [],
    publication: { state: 'pending', lastError: null, startedAt, deadlineAt } }))
  registerService('test-missed-loop', { cadenceMs: 1000, deadlineMs: 5000 }, Date.now() - 10 * 60_000)
  await trackService('test-healthy-loop', { cadenceMs: 60_000, deadlineMs: 5000 }, async () => undefined)
  const pool = new pg.Pool()
  const query = vi.fn(async (_query: unknown, values: unknown[]) => ({ rows: values[0] === principal.id ? [{
    id: principal.id, name: principal.name, audience: principal.audience, grants: principal.grants,
    expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null,
  }] : [] }))
  vi.spyOn(pool, 'connect').mockImplementation(async () => ({ query, release: vi.fn() }) as unknown as pg.PoolClient)
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => token === 'reader' ? principal : denied)
  const recordDenied = vi.fn(async () => undefined)
  const commands = { recordDenied } as unknown as PostgresCommandCoordinator
  const mainId = randomUUID()
  const computerMaintenance = new FleetMaintenanceService(pool, mainId, () => undefined, commands,
    new ComputerMaintenance(fakeComputer().ports),
    { workerPublication: () => readWorkerReleasePublication({ directory, version: '1.1.0' }) } as FleetSources)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, computerMaintenance } as unknown as OperatorServices },
  })
  const read = (token: string, query = '') => app.inject({ method: 'GET', url: `/api/management/computers/maintenance${query}`,
    headers: { authorization: `Bearer ${token}` } })
  try {
    const result = await read('reader', '?refresh=true')
    expect(result.statusCode).toBe(200)
    const [main] = (result.json() as { computers: { status: { services: unknown[] };
      workerPublication: { state: string; lastError: string } }[] }).computers
    expect(main!.status.services).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: 'test-missed-loop', status: 'stalled', lastStartedAt: null }),
      expect.objectContaining({ name: 'test-healthy-loop', status: 'ok', lastError: null }),
    ]))
    expect(main!.workerPublication).toMatchObject({ state: 'failed', startedAt, deadlineAt })
    expect(main!.workerPublication.lastError).toMatch(/^WORKER_PUBLICATION_DEADLINE_EXCEEDED: phase publishing, age 180 min, over the 120 min limit/u)

    const rejection = await read('denied')
    expect(rejection.statusCode).toBe(403)
    expect(recordDenied).toHaveBeenCalledWith(denied.id, 'http', 'computers_maintenance_status', mainId)
  } finally {
    await app.close()
    await pool.end()
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  }
})

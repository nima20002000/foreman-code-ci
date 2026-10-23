import { randomUUID } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import { buildApp } from '../../app.js'
import { PostgresAccessService } from '../access/postgres.js'
import type { PostgresCommandCoordinator } from '../commands/postgres.js'
import type { ComputerMaintenance } from './maintenance.js'
import { FleetMaintenanceService, type FleetSources } from './fleet.js'
import type { OperatorServices } from '../../mcp/operator/types.js'

it('reads persisted Worker publication errors through authenticated HTTP and denies a caller without settings read', async () => {
  const parent = join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'worker-publication-'))
  const mainId = randomUUID()
  const principal: ManagementPrincipal = { id: randomUUID(), name: 'Reader', audience: 'operator', revokedAt: null,
    expiresAt: '2099-01-01T00:00:00Z', grants: [{ actions: ['settings:read', 'capabilities:read'], scope: {} }] }
  const denied: ManagementPrincipal = { ...principal, id: randomUUID(), grants: [{ actions: ['capabilities:read'], scope: {} }] }
  const publication = { version: '1.1.0', state: 'failed', lastError: 'WORKER_RELEASE_ASSET_UNAVAILABLE: asset missing' }
  const indexPath = join(directory, 'index.json')
  await writeFile(indexPath, JSON.stringify({ publication }))
  const pool = new pg.Pool()
  const query = vi.fn(async (_query: unknown, values: unknown[]) => ({ rows: values[0] === principal.id ? [{
    id: principal.id, name: principal.name, audience: principal.audience, grants: principal.grants,
    expires_at: new Date(principal.expiresAt), revoked_at: null, delegated_from: null,
  }] : [] }))
  vi.spyOn(pool, 'connect').mockImplementation(async () => ({ query, release: vi.fn() }) as unknown as pg.PoolClient)
  const access = new PostgresAccessService(pool)
  vi.spyOn(access, 'authenticate').mockImplementation(async token => token === 'reader' ? principal : denied)
  const recordDenied = vi.fn()
  const commands = { recordDenied } as unknown as PostgresCommandCoordinator
  const local = { status: async () => ({ harnesses: [], tasks: [], observedAt: new Date().toISOString(),
    system: { packageUpdates: null, rebootRequired: false, sudo: false, disk: null } }) } as unknown as ComputerMaintenance
  const sources = { workerPublication: async () => JSON.parse(await readFile(indexPath, 'utf8')).publication } as FleetSources
  const computerMaintenance = new FleetMaintenanceService(pool, mainId, () => undefined, commands, local, sources)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, computerMaintenance } as unknown as OperatorServices },
  })
  const read = (token: string) => app.inject({ method: 'GET', url: '/api/management/computers/maintenance',
    headers: { authorization: `Bearer ${token}` } })
  try {
    const result = await read('reader')
    expect(result.statusCode).toBe(200)
    expect(result.json()).toMatchObject({ computers: [{ workerPublication: publication }] })
    const rejection = await read('denied')
    expect(rejection.statusCode).toBe(403)
    expect(recordDenied).toHaveBeenCalledWith(denied.id, 'http', 'computers_maintenance_status', mainId)
    const published = { ...publication, state: 'published', lastError: null }
    await writeFile(indexPath, JSON.stringify({ publication: published }))
    const readback = await read('reader')
    expect(readback.json()).toMatchObject({ computers: [{ workerPublication: published }] })
  } finally {
    await app.close()
    await pool.end()
    vi.restoreAllMocks()
    await rm(directory, { recursive: true, force: true })
  }
})

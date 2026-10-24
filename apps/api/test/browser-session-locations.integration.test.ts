import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { browserProfilesMigration } from '../src/infrastructure/browserProfilesMigration.js'
import { endpointFixture, browserSubjects } from '../src/modules/browser-runtime/endpoints.test-support.js'
import { createBrowserSessionLocations, createBrowserSessionRouter } from '../src/modules/browser-runtime/sessionRouter.js'
import type { BrowserSessionService } from '../src/modules/browser-runtime/service.js'
import { createFixtureSchema, dropFixtureSchema, ownedTestDatabaseUrl } from './helpers/testResources.js'

let admin: pg.Pool
let pool: pg.Pool
let schema: string
let remote: Awaited<ReturnType<typeof endpointFixture>> | undefined

beforeEach(async () => {
  const connectionString = ownedTestDatabaseUrl()
  admin = new pg.Pool({ connectionString, max: 1 })
  schema = `browser_locations_${randomUUID().replaceAll('-', '')}`
  await createFixtureSchema(admin, schema)
  pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 2 })
  await pool.query(browserProfilesMigration.sql)
})

afterEach(async () => {
  await remote?.close()
  remote = undefined
  await pool?.end()
  if (admin) {
    await dropFixtureSchema(admin, schema)
    await admin.end()
  }
  vi.restoreAllMocks()
})

it('routes and closes a reused session after fresh preparation on a re-paired computer', async () => {
  const worker = remote = await endpointFixture()
  const locations = createBrowserSessionLocations(pool)
  const input = worker.bindSubject(browserSubjects()[0]!)
  const original = await worker.sessions.open(worker.owner, input)
  if (original.kind !== 'ready') throw new Error('The Worker fixture did not prepare')
  await locations.save(original.session, 'old-installation')
  const router = createBrowserSessionRouter({ localComputerId: 'other-main',
    local: {} as BrowserSessionService<ManagementPrincipal>, locations,
    pairing: { current: async computerId => ({ computerId, installationId: 'new-installation', connectionId: 'connection' }),
      assertCurrent: async () => undefined, assertInstallation: async () => undefined,
      wrappingKey: async () => { throw new Error('Unexpected key operation') } },
    authority: { callerId: principal => principal.id, actor: async () => 'viewer',
      subject: async () => undefined, session: async () => undefined, setup: async () => undefined },
    computers: async () => ['main'], subjectComputer: async () => 'main',
    transport: { invoke: async (_binding, method, principal, args) =>
      Reflect.apply(worker.sessions[method], worker.sessions, [principal, ...args]) },
    media: () => { throw new Error('Unexpected media') },
  })
  await expect(router.get(worker.owner, original.session.id)).rejects.toMatchObject({ code: 'BROWSER_PAIRING_CHANGED' })
  const prepared = await router.open(worker.owner, { ...input, commandId: 'prepare-after-repair' })
  expect(prepared).toMatchObject({ kind: 'ready', session: { id: original.session.id } })
  expect(await locations.session(original.session.id)).toMatchObject({ installationId: 'new-installation' })
  expect((await router.get(worker.owner, original.session.id)).session).toEqual(original.session)
  expect(await router.close(worker.owner, { sessionId: original.session.id, commandId: 'close-after-repair' }))
    .toMatchObject({ state: 'closed' })
  expect((await worker.sessions.get(worker.owner, original.session.id)).session.state).toBe('closed')
})

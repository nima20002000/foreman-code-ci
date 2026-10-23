import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import type { BrowserSession } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { browserProfilesMigration } from '../src/infrastructure/browserProfilesMigration.js'
import { browserSubjects } from '../src/modules/browser-runtime/endpoints.test-support.js'
import { deviceIdentityMigration } from '../src/modules/devices/migration.js'
import { createProductionBrowser, type BrowserRemote } from '../src/modules/collaboration/browserComposition.js'
import { CHAT_BROWSER_IDLE_MS } from '../src/modules/collaboration/chatBrowser.js'
import { MainBrowserRuntime } from '../src/modules/collaboration/mainBrowserRuntime.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { createFixtureSchema, dropFixtureSchema, ownedTestDatabaseUrl, removeFixtureDirectory } from './helpers/testResources.js'

let admin: pg.Pool
let pool: pg.Pool
let schema: string
let root: string
const browsers: ReturnType<typeof createProductionBrowser>[] = []
const mainId = randomUUID(), computerId = randomUUID(), installationId = randomUUID()

beforeEach(async () => {
  const connectionString = ownedTestDatabaseUrl()
  admin = new pg.Pool({ connectionString, max: 1 })
  schema = `browser_chat_restart_${randomUUID().replaceAll('-', '')}`
  await createFixtureSchema(admin, schema)
  pool = new pg.Pool({ connectionString, options: `-c search_path=${schema}`, max: 2 })
  await pool.query('create table management_principals(id text primary key)')
  await pool.query(deviceIdentityMigration.sql)
  await pool.query(browserProfilesMigration.sql)
  await pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
    values($1,$2,$3,$4,$5::jsonb)`, [computerId, mainId, installationId, 'fixture-key', JSON.stringify({
    mainId, deviceId: computerId, workerInstallationId: installationId, publicKeyFingerprint: 'b'.repeat(64),
    keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat', 'metrics:report'],
  })])
  root = await privateFixtureDirectory('browser-chat-restart-')
  // Main has no native browser in this test; the paired host is a separate external port.
  vi.spyOn(MainBrowserRuntime.prototype, 'start').mockResolvedValue()
})

afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.stop()
  await pool?.end()
  if (admin) {
    await dropFixtureSchema(admin, schema)
    await admin.end()
  }
  if (root) await removeFixtureDirectory(root)
  vi.restoreAllMocks()
})

async function fixture() {
  const subject = browserSubjects()[1]!
  const session: BrowserSession = { id: randomUUID(), subject, profileId: 'profile', computerId,
    browserGeneration: 1, state: 'ready', selectedTabId: 'tab' }
  const release = vi.fn<BrowserRemote['release']>(async input => ({ sessionId: input.sessionId, state: 'closed', reason: null }))
  const remote: BrowserRemote = { prepare: async () => ({ kind: 'ready', session,
    control: { sessionId: session.id, state: 'agent', epoch: 0, controllingViewerId: null, reason: null } }),
    release, ready: async () => true,
    profiles: { endpoint: async () => { throw new Error('Unexpected profile operation') } },
    sessions: { invoke: async () => { throw new Error('Unexpected browser request') } },
    media: () => { throw new Error('Unexpected media') } }
  const configuration = makeCurrentWorkflowFixture('browser-chat-restart', 'single').configurations[0]!
  const start = async () => {
    const browser = createProductionBrowser({ pool, stateDirectory: root, binding: () => null,
      assertHostOwnership: async () => undefined, reportFailure: error => { throw error }, remote: () => remote })
    browsers.push(browser)
    // The saved Agent assignment is external to session recovery, as is the paired host transport.
    vi.spyOn(browser.authority, 'details').mockImplementation(async subject => ({ subject, configuration,
      browser: { enabled: true, profileId: session.profileId }, computerId, active: true, readOnly: false,
      workflowVersionId: null, tools: [] }))
    await browser.start(mainId)
    browser.chat.stop()
    return browser
  }
  const original = await start()
  await original.lifecycle.prepare({ subject, browser: { enabled: true, profileId: session.profileId }, computerId, commandId: 'chat-open' })
  await original.stop()
  return { session, release, restarted: await start(), start }
}

it('closes a retained Worker chat after API restart and ten idle minutes without adopting it again', async () => {
  let now = Date.now()
  vi.spyOn(Date, 'now').mockImplementation(() => now)
  const f = await fixture()
  await f.restarted.chat.sweep()
  expect(f.release).not.toHaveBeenCalled()
  now += CHAT_BROWSER_IDLE_MS
  await f.restarted.chat.sweep()
  expect(f.release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: f.session.id }))
  await f.restarted.stop()
  const again = await f.start()
  await again.chat.sweep()
  now += CHAT_BROWSER_IDLE_MS
  await again.chat.sweep()
  expect(f.release).toHaveBeenCalledTimes(1)
})

it('yields a retained Worker chat to a Run on the same profile after API restart', async () => {
  const f = await fixture()
  await f.restarted.chat.yieldToRun(f.session.profileId, computerId)
  expect(f.release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: f.session.id, subject: f.session.subject }))
})

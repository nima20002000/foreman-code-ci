import { randomUUID } from 'node:crypto'
import { afterAll, afterEach, beforeAll, expect, it, vi } from 'vitest'
import type { AgentSubject, BrowserSession } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import * as credentials from '../src/modules/access/conversationCredentials.js'
import type { BrowserSubjectDetails } from '../src/modules/collaboration/browserAuthority.js'
import { createProductionBrowser } from '../src/modules/collaboration/browserComposition.js'
import { CHAT_BROWSER_IDLE_MS } from '../src/modules/collaboration/chatBrowser.js'
import { currentDatabase } from './helpers/database.js'

let db: Awaited<ReturnType<typeof currentDatabase>>
const browsers: ReturnType<typeof createProductionBrowser>[] = []
beforeAll(async () => { db = await currentDatabase() })
afterEach(async () => {
  for (const browser of browsers.splice(0)) await browser.stop()
  vi.restoreAllMocks()
})
afterAll(async () => { await db.close() })

const agent = { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent',
  productRole: 'coder' as const, displayName: 'Worker', configurationVersionId: 'configuration' }
const chatSubject: Extract<AgentSubject, { kind: 'conversation' }> = { kind: 'conversation', agent, conversationId: 'chat' }
const runSubject: AgentSubject = { kind: 'execution', agent,
  execution: { runId: 'run', workflowVersionId: 'version', executionId: 'execution', attempt: 1 } }

async function fixture() {
  const mainId = randomUUID(), deviceId = randomUUID(), installationId = randomUUID()
  await db.pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
    values($1,$2,$3,$4,$5::jsonb)`, [deviceId, mainId, installationId, 'fixture-public-key', JSON.stringify({
    mainId, deviceId, workerInstallationId: installationId, publicKeyFingerprint: 'b'.repeat(64), keyRevision: 1,
    authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat', 'metrics:report'],
  })])
  let active = true
  const unused = async (): Promise<never> => { throw new Error('Unexpected browser operation') }
  const release = vi.fn(async (input: { sessionId: string }) => ({ sessionId: input.sessionId, state: 'closed' as const, reason: null }))
  const prepare = vi.fn(async (input: { subject: AgentSubject }) => {
    const session: BrowserSession = { id: randomUUID(), subject: input.subject, profileId: 'profile',
      computerId: deviceId, browserGeneration: 1, state: 'ready', selectedTabId: null }
    return { kind: 'ready' as const, session, control: { sessionId: session.id, state: 'agent' as const,
      epoch: 0, controllingViewerId: null, reason: null } }
  })
  const start = async () => {
    const browser = createProductionBrowser({ pool: db.pool, stateDirectory: db.directory, binding: () => null,
      assertHostOwnership: unused, reportFailure: () => undefined,
      remote: () => ({ profiles: { endpoint: unused }, sessions: { invoke: unused }, ready: async () => true,
        status: async computerId => ({ computerId, ready: true, phase: 'ready', reason: null }),
        media: () => { throw new Error('Unexpected browser media') }, prepare, release }) })
    browsers.push(browser)
    vi.spyOn(browser.authority, 'details').mockImplementation(async subject => ({ subject, active, computerId: deviceId,
      browser: { enabled: true, profileId: 'profile' } }) as BrowserSubjectDetails)
    await browser.start(mainId)
    return browser
  }
  const first = await start()
  const seed = async (subject: AgentSubject) => first.lifecycle.prepare({ subject, browser: { enabled: true, profileId: 'profile' },
    computerId: deviceId, commandId: randomUUID() })
  return { first, start, seed, deviceId, prepare, release, archive: () => { active = false } }
}

it.each(['Run', 'idle', 'archived'] as const)('recovers a paired Worker chat browser after Main restarts and closes it for %s', async reason => {
  const f = await fixture()
  const prepared = await f.seed(chatSubject)
  if (prepared.kind !== 'ready') throw new Error('Expected the chat browser')
  await f.first.stop()
  const restarted = await f.start()
  if (reason === 'Run') await restarted.chat.yieldToRun('profile', f.deviceId)
  else {
    await restarted.chat.sweep()
    expect(f.release).not.toHaveBeenCalled()
    if (reason === 'idle') vi.spyOn(Date, 'now').mockReturnValue(Date.now() + CHAT_BROWSER_IDLE_MS)
    else f.archive()
    await restarted.chat.sweep()
  }
  expect(f.release).toHaveBeenCalledExactlyOnceWith(expect.objectContaining({ sessionId: prepared.session.id, subject: chatSubject }))
  await restarted.chat.sweep()
  expect(f.release).toHaveBeenCalledTimes(1)
})

it('blocks chat beside a retained paired Worker Run after Main restarts and allows it after confirmed release', async () => {
  const f = await fixture()
  const prepared = await f.seed(runSubject)
  if (prepared.kind !== 'ready') throw new Error('Expected the Run browser')
  await f.first.stop()
  const restarted = await f.start()
  vi.spyOn(credentials, 'readConversationCredential').mockResolvedValue({ subject: chatSubject } as
    NonNullable<Awaited<ReturnType<typeof credentials.readConversationCredential>>>)
  const principal = { id: 'chat-principal', audience: 'worker' } as ManagementPrincipal
  await expect(restarted.chat.sessionFor(principal)).rejects.toMatchObject({ code: 'BROWSER_IN_USE_BY_RUN' })
  expect(f.prepare).toHaveBeenCalledTimes(1)
  await restarted.lifecycle.release({ sessionId: prepared.session.id, subject: runSubject,
    commandId: 'close-run', reason: 'terminal' })
  await expect(restarted.chat.sessionFor(principal)).resolves.toEqual(expect.any(String))
  expect(f.prepare).toHaveBeenCalledTimes(2)
})

import { request } from 'node:http'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import Fastify from 'fastify'
import { expect, it, vi } from 'vitest'
import type { DeliveryTarget } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { trackInFlightRequests } from '../src/infrastructure/inFlightRequests.js'
import { registerAgentDeliveryRoutes, registerOperatorDeliveryRoutes } from '../src/modules/workflow-chat/httpDelivery.js'
import type { ChatDeliveryRouter } from '../src/modules/workflow-chat/delivery.js'
import { createBrowserHost, type BrowserHostOptions } from '../src/modules/browser-runtime/hostFactory.js'
import { ManagedBrowserNativeDriver } from '../src/modules/browser-runtime/nativeDriver.js'
import { BrowserFileStore } from '../src/modules/browser-runtime/files.js'
import { createBrowserRuntimeJournal } from '../src/modules/browser-runtime/journal.js'
import type { BrowserRuntimeSessionRecord } from '../src/modules/browser-runtime/types.js'
import { deferred } from './helpers/deferred.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'
import { removeFixtureDirectory } from './helpers/testResources.js'

const principal: ManagementPrincipal = { id: 'reader', name: 'Reader', audience: 'operator',
  expiresAt: '2099-01-01T00:00:00Z', revokedAt: null, grants: [] }

for (const kind of ['operator_conversation', 'agent_conversation'] as const) {
  it(`closes promptly with an in-flight ${kind} delivery read`, async () => {
    const entered = deferred(), release = deferred()
    const app = Fastify()
    const tracked = trackInFlightRequests(app, { graceMs: 10_000, closable: url => url.startsWith('/mcp') })
    app.decorateRequest('operatorPrincipal', null, [])
    app.addHook('preHandler', async request => { request.operatorPrincipal = principal })
    const delivery = { read: async () => { entered.resolve(); await release.promise; return { receipts: [] } } }
    registerOperatorDeliveryRoutes(app, delivery as unknown as ChatDeliveryRouter)
    registerAgentDeliveryRoutes(app, delivery as unknown as ChatDeliveryRouter)
    const target: DeliveryTarget = kind === 'operator_conversation' ? { kind, conversationId: 'chat' }
      : { kind, conversationId: 'chat', agent: { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node',
        agentId: 'agent' } }
    const path = kind === 'operator_conversation' ? '/api/operator/conversations/chat/deliveries/read'
      : '/api/workspaces/workspace/agent-chat/deliveries/read'
    const stateDirectory = await privateFixtureDirectory('delivery-shutdown-')
    const host = await browserHost(stateDirectory)
    app.addHook('onClose', async () => { await host.close() })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const call = request(`${address}${path}?retry=1`, { method: 'POST', agent: false,
      headers: { 'content-type': 'application/json' } })
    const response = new Promise<string | number | undefined>(resolve => {
      call.on('error', error => resolve((error as NodeJS.ErrnoException).code))
      call.on('response', result => { result.resume(); result.once('end', () => resolve(result.statusCode)) })
    })
    call.end(JSON.stringify({ target }))
    let closing: Promise<void> | undefined
    try {
      await entered.promise
      expect(tracked.size()).toBe(1)
      let closed = false
      closing = app.close().then(() => { closed = true })
      await expect.poll(() => closed, { timeout: 2000 }).toBe(true)
      expect(await response).toBe('ECONNRESET')
    } finally {
      release.resolve()
      call.destroy()
      await (closing ?? app.close())
      await removeFixtureDirectory(stateDirectory)
    }
  })
}

function closedRecord(index: number, closing = false): BrowserRuntimeSessionRecord {
  const id = `session-${index}`
  return { session: { id, setupForProfileId: 'profile', profileId: 'profile', computerId: 'computer',
    browserGeneration: 1, state: 'closed', selectedTabId: null },
  control: { sessionId: id, state: 'paused', epoch: 1, controllingViewerId: null, reason: 'Browser session closed.' },
  readOnly: false, leases: [], prepareCommandId: id, closing }
}

async function browserHost(stateDirectory: string) {
  return createBrowserHost({ stateDirectory, computerId: 'computer', installationId: 'installation',
    runtime: { rootDirectory: stateDirectory, pythonExecutable: 'python', chromiumExecutable: 'chromium', bridgeScript: 'bridge.py',
      runtimeVersion: '1', profileFormat: 1 },
    subjectAuthority: {} as BrowserHostOptions['subjectAuthority'], pairing: {} as BrowserHostOptions['pairing'],
    keys: {} as BrowserHostOptions['keys'], assertHostOwnership: async () => undefined, reportFailure: error => { throw error } })
}

it('closes an idle browser host without replaying historical cleanup and retains its installer drain', async () => {
  const stateDirectory = await privateFixtureDirectory('idle-browser-shutdown-')
  const root = join(stateDirectory, 'browser'), journal = createBrowserRuntimeJournal(join(root, 'journal'))
  const records = Array.from({ length: 136 }, (_, index) => closedRecord(index))
  await Promise.all(records.map(record => journal.saveSession(record)))
  const releaseCleanup = deferred()
  const cleanup = vi.spyOn(BrowserFileStore.prototype, 'closeSession').mockImplementation(() => releaseCleanup.promise)
  const app = Fastify()
  let host: Awaited<ReturnType<typeof browserHost>> | undefined
  let closing: Promise<void> | undefined
  try {
    host = await browserHost(stateDirectory)
    await host.storage.create('profile', 1)
    app.addHook('onClose', async () => { await host!.close() })
    await app.listen({ host: '127.0.0.1', port: 0 })
    const installer = await import(new URL('../../../scripts/local-production-runtime.mjs', import.meta.url).href)
    expect(await installer.requestProductionBrowserDrain({ stateDirectory, operation: 'beginDrain', commandId: 'update' }))
      .toEqual({ state: 'drained', activeSessions: 0 })
    let closed = false
    closing = app.close().then(() => { closed = true })
    await expect.poll(() => closed, { timeout: 2000 }).toBe(true)
    expect(cleanup).not.toHaveBeenCalled()
    expect((await journal.loadSessions()).sort((a, b) => a.session.id.localeCompare(b.session.id)))
      .toEqual(records.sort((a, b) => a.session.id.localeCompare(b.session.id)))
    expect(JSON.parse(await readFile(join(root, 'runtime-drain.json'), 'utf8')))
      .toEqual({ commandId: 'update', state: 'draining' })
    await expect(installer.requestProductionBrowserDrain({ stateDirectory, operation: 'status', commandId: 'update' }))
      .rejects.toMatchObject({ code: 'ENOENT' })
  } finally {
    releaseCleanup.resolve()
    await (closing ?? app.close())
    await host?.close()
    cleanup.mockRestore()
    await removeFixtureDirectory(stateDirectory)
  }
})

it('retries cleanup for a durably closed browser session whose resource cleanup is still pending', async () => {
  const stateDirectory = await privateFixtureDirectory('pending-browser-shutdown-')
  const journal = createBrowserRuntimeJournal(join(stateDirectory, 'browser', 'journal'))
  await journal.saveSession(closedRecord(0, true))
  const cleanup = vi.spyOn(BrowserFileStore.prototype, 'closeSession').mockRejectedValueOnce(new Error('Files still settling'))
    .mockResolvedValue(undefined)
  const closeProfile = vi.spyOn(ManagedBrowserNativeDriver.prototype, 'closeProfile').mockResolvedValue(undefined)
  let host: Awaited<ReturnType<typeof browserHost>> | undefined
  try {
    host = await browserHost(stateDirectory)
    await expect(host.close()).rejects.toMatchObject({ code: 'BROWSER_RUNTIME_BUSY' })
    expect(await journal.loadSessions()).toEqual([closedRecord(0, true)])
    await host.close()
    expect(await journal.loadSessions()).toEqual([closedRecord(0)])
    expect(cleanup).toHaveBeenCalledTimes(2)
  } finally {
    await host?.close()
    cleanup.mockRestore()
    closeProfile.mockRestore()
    await removeFixtureDirectory(stateDirectory)
  }
})

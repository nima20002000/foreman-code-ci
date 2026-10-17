import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentConfigurationVersionSchema, type NativeSessionReference } from '@foreman-code/contracts'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService, type AgentChatManagerFactory } from '../src/modules/conversations/agentChat.js'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { createProductionWorkerConversations } from '../src/modules/conversations/workerProduction.js'
import { WorkerConversationHost } from '../src/modules/conversations/workerHost.js'
import { WorkerConversationJournal } from '../src/modules/conversations/workerJournal.js'
import { workerConversationCallbacks } from '../src/modules/conversations/workerCallbacks.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { HarnessCatalogService } from '../src/modules/harnesses/catalog.js'
import { PostgresSettingsRepository } from '../src/modules/settings/postgres.js'
import type { NativeInitialTurnInput, NativeSessionStart } from '../src/modules/harnesses/port.js'
import type { WorkerConversationReceipt } from '@foreman-code/contracts/remote-execution-rpc'
import { ChatManager, waitFor } from './helpers/operatorChatFixture.js'
import { agent3Database, seedAgent3 } from './helpers/wave25Agent3.js'
import { graphRpc } from './eng04-graph-composition-fixture.js'

class RecordedNative extends ChatManager {
  disposed = false
  async createSession(): Promise<NativeSessionReference> {
    this.sessions++
    return { harness: this.harness, providerVersion: 'recorded-provider', nativeSessionId: randomUUID() }
  }
  async *startInitialTurn(start: NativeSessionStart, input: NativeInitialTurnInput, signal?: AbortSignal) {
    const session = await this.createSession()
    await input.onSessionObserved(session)
    yield* this.startTurn(session, input, signal)
  }
  async dispose() { this.disposed = true; this.disposals++ }
}

async function fixture() {
  const db = await agent3Database()
  const recorded = workerConversationFixture('agent')
  const seed = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  seed.configurations = seed.configurations.map(value => AgentConfigurationVersionSchema.parse({ ...value,
    harness: recorded.configuration.harness, harnessProfileSelection: recorded.binding.profile }))
  const seeded = await seedAgent3(db.pool, db.directory, seed, { run: false })
  const node = seeded.version.definition.nodes[0]!
  const configuration = seeded.configurations.find(value => value.agentId === node.agentId)!
  const context = { workspaceId: seeded.scope.workspaceId, workflowId: seeded.scope.workflowId,
    workflowNodeId: node.id, agentId: node.agentId }
  const repository = new PostgresAgentChatRepository(db.pool)
  const messages = new PostgresOperatorConversationRepository(db.pool)
  const access = new PostgresAccessService(db.pool)
  const writer = await access.issue({ name: 'Chat lifecycle owner', audience: 'operator',
    grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
  const reader = await access.issue({ name: 'Chat lifecycle reader', audience: 'operator',
    grants: [{ actions: ['agent_chat:read'], scope: {} }] })
  const commands = new PostgresCommandCoordinator(db.pool)
  const harnesses = new HarnessCatalogService({ qualify: async value => ({ harness: value.harness,
    version: 'recorded-provider', authenticated: true, ready: true, structuredEvents: true, supportsResume: true,
    supportsCancellation: true, supportsWorkingDirectory: true, supportsStartupPrompt: true,
    supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [] }) },
  new PostgresSettingsRepository(db.pool), commands, db.directory)
  const agents = new OperatorAgentMutationService(db.pool, commands, harnesses,
    { validateSelection: async () => {} })
  const conversation = await repository.ensureForControls(agentChatKey(context), { context,
    agentConfigurationVersionId: configuration.id, harness: 'codex', origin: { kind: 'fresh' },
    workingDirectory: db.directory, runtimeDirectory: join(db.directory, 'chat') }, async () => {})
  const records: WorkerConversationReceipt[] = []
  const journal = new WorkerConversationJournal({ read: async () => structuredClone(records),
    change: async (_id, apply) => apply(records) }, 16)
  const natives: RecordedNative[] = []
  let host: WorkerConversationHost
  const workflows = new PostgresWorkflowRepository(db.pool)
  const profiles = { admit: async () => {
    const row = (await repository.get(conversation.id))!
    const selected = (await workflows.getAgentConfiguration(row.agent_configuration_version_id))!
    return { override: { configuration: selected.harness, target: selected.harnessProfileSelection!.target } }
  }, revalidate: async () => {} }
  const production = createProductionWorkerConversations({ pool: db.pool, operators: messages, agents: repository,
    endpoint: () => ({ captureRequest: () => ({ binding: recorded.connection,
      request: async (raw: unknown) => ({ payload: await host.handle(raw, recorded.connection) }) }) }),
    profiles, claudeProfiles: profiles, registry: {}, qualifications: {}, suiteRevisions: {}, access,
    mcpForward: () => ({}),
  } as unknown as Parameters<typeof createProductionWorkerConversations>[0])
  const callbacks = workerConversationCallbacks({ currentBinding: () => recorded.connection,
    capture: () => ({ binding: recorded.connection, request: async (raw, options) => ({
      payload: await production.bridge.handle(raw, recorded.connection, options?.signal ?? AbortSignal.timeout(1000)) }) }) })
  host = new WorkerConversationHost({ ...callbacks, journal, currentBinding: () => recorded.connection,
    allocate: async (binding, selected) => {
      const native = new RecordedNative(binding.harness as 'codex' | 'claude')
      natives.push(native)
      return { manager: native, start: async options => ({ kind: 'agent-chat', configuration: selected,
        conversationId: conversation.id, workflowId: context.workflowId, workflowNodeId: context.workflowNodeId,
        workingDirectory: binding.workingDirectory, ...options } as NativeSessionStart),
      nativeOwner: async session => ({ sessionId: session.nativeSessionId,
        processIdentityDigest: commandInputHash({ binding, session }).slice('sha256:'.length) }),
      close: async () => native.dispose() }
    },
  })
  const managers: AgentChatManagerFactory = (id, selected, directory) => production.create({ conversationId: id,
    configuration: selected, workingDirectory: directory, appMcpAccess: 'none' })
  const createChat = (factory = managers) => new AgentChatService(db.pool, repository, messages,
    new PostgresWorkflowRepository(db.pool), { getForWorkspace: async () => { throw new Error('No Run selection') },
      getExecution: async () => { throw new Error('No execution selection') }, executionPages() { throw new Error('No Run pages') } },
    factory, db.directory)
  let chat = createChat()
  const services = { commands, agentChat: chat, extensions: { agents } }
  const app = buildApp({ logger: false, readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: services as never } })
  const call = (token: string, name: string, args: Record<string, unknown>) => graphRpc(app, token, 'tools/call', { name, arguments: args })
  const send = async (requestId: string) => {
    const response = await call(writer.token, 'agent_chat_send', { workspaceId: context.workspaceId,
      request: { requestId, content: 'Reply once', intent: 'next_turn', expectedConversationId: conversation.id,
        context: { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId } } })
    expect(response.result?.isError, JSON.stringify(response)).not.toBe(true)
    await waitFor(async () => ['completed', 'failed'].includes((await repository.turn(conversation.id, requestId))?.delivery ?? ''))
    expect((await repository.turn(conversation.id, requestId))?.delivery).toBe('completed')
  }
  return { db, recorded, configuration, conversation, context, repository, journal, records, natives, managers,
    createChat, send, call, writer, reader, get chat() { return chat },
    async replaceChat(factory: AgentChatManagerFactory) {
      await chat.shutdown()
      chat = createChat(factory)
      services.agentChat = chat
      return chat
    },
    async close() { await chat.shutdown(); await host.shutdown(); await production.close(); await app.close(); await db.close() } }
}

it('starts a replacement Worker session after a harness change and can return to the original harness without replay', async () => {
  const f = await fixture()
  try {
    await f.send('before-change')
    const original = (await f.repository.get(f.conversation.id))!.native_session_id
    const first = structuredClone(f.records[0]!)
    for (const harness of ['claude', 'codex'] as const) {
      const configuration = harness === 'codex' ? f.configuration.harness : { harness: 'claude', model: 'recorded',
        authMode: 'subscription', configDirectory: '/recorded/claude-profile', permissionMode: 'default',
        sandbox: 'read-only', tools: [], permissionRules: [], instructions: '', mcpServers: {} }
      const updated = await f.call(f.writer.token, 'agent_update', { workspaceId: f.context.workspaceId,
        agentId: f.context.agentId, configuration, harnessProfileSelection: { ...f.recorded.binding.profile,
          target: { ...f.recorded.binding.profile.target, harnessInstallationId: harness } } })
      expect(updated.result?.isError, JSON.stringify(updated)).not.toBe(true)
      const requestId = `after-${harness}`
      await f.send(requestId)
      const row = (await f.repository.get(f.conversation.id))!
      expect(row.native_session_id).not.toBe(original)
      expect(row.harness).toBe(harness)
      expect(f.natives.at(-2)!.disposed).toBe(true)
    }
    expect(f.natives.map(native => native.sessions)).toEqual([1, 1, 1])
    expect(f.natives.map(native => native.turns)).toEqual([1, 1, 1])
    expect((await f.journal.read(first.binding))?.turns).toEqual(first.turns)
    expect((await f.journal.read(first.binding))?.closed).toBe(true)
    const denied = await f.call(f.reader.token, 'agent_chat_send', { workspaceId: f.context.workspaceId,
      request: { requestId: 'denied', content: 'No input', intent: 'next_turn', expectedConversationId: f.conversation.id,
        context: f.context } })
    expect(denied.error || denied.result?.isError).toBeTruthy()
    expect(f.natives).toHaveLength(3)
  } finally { await f.close() }
})

it('disposes a released Agent runtime and attaches the persisted session for the following turn', async () => {
  const f = await fixture()
  const managers: RecordedNative[] = []
  try {
    const factory: AgentChatManagerFactory = () => {
      const native = Object.assign(new RecordedNative(), { retireTurn: async () => ({ runtimeReleased: true as const }) })
      const start = native.startTurn.bind(native)
      native.startTurn = async function* (...args) {
        if (native.disposed) throw new Error('Released native runtime cannot receive another turn')
        yield* start(...args)
      }
      managers.push(native)
      return native
    }
    const chat = await f.replaceChat(factory)
    for (const requestId of ['released', 'following']) {
      await chat.send(f.writer.principal, f.context.workspaceId, { requestId, content: 'Reply once', intent: 'next_turn',
        expectedConversationId: f.conversation.id, context: f.context })
      await waitFor(async () => ['completed', 'failed'].includes((await f.repository.turn(f.conversation.id, requestId))?.delivery ?? ''))
      expect((await f.repository.turn(f.conversation.id, requestId))?.delivery).toBe('completed')
    }
    expect(managers).toHaveLength(2)
    expect(managers[0]!.disposed).toBe(true)
    expect(managers.map(native => native.sessions)).toEqual([1, 0])
    expect(managers.map(native => native.attachments)).toEqual([0, 1])
    expect(managers.map(native => native.turns)).toEqual([1, 1])
  } finally { await f.close() }
})

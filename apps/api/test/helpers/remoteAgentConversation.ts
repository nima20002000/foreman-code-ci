import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect } from 'vitest'
import { AgentConfigurationVersionSchema, type AgentConfigurationVersion } from '@foreman-code/contracts'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { WorkerConversationRpcRequestSchema, type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { buildApp } from '../../src/app.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { AgentChatService } from '../../src/modules/conversations/agentChat.js'
import { agentChatKey, PostgresAgentChatRepository } from '../../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../../src/modules/conversations/operatorChatRepository.js'
import { createProductionWorkerConversations } from '../../src/modules/conversations/workerProduction.js'
import { workerConversationFixture } from '../../src/modules/conversations/workerFixtures.test-support.js'
import { workerConversationCallbacks } from '../../src/modules/conversations/workerCallbacks.js'
import { WorkerConversationHost } from '../../src/modules/conversations/workerHost.js'
import { RemoteOperationJournal } from '../../src/modules/runs/remote/operationJournal.js'
import { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { OperatorAgentMutationService } from '../../src/modules/workspaces/operatorAgents.js'
import { graphRpc, graphRpcValue } from '../eng04-graph-composition-fixture.js'
import { agent3Database, seedAgent3 } from './wave25Agent3.js'
import { remoteChatProvider } from './remoteChatProvider.js'
import { deferred } from './deferred.js'

export async function remoteAgentConversation(harness: 'codex' | 'claude') {
  const db = await agent3Database()
  const recorded = workerConversationFixture('agent', harness)
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  const provider = await remoteChatProvider(harness, db.directory)
  fixture.configurations = fixture.configurations.map(value => AgentConfigurationVersionSchema.parse({ ...value,
    harness: { ...recorded.configuration.harness, model: 'test-model',
      ...(harness === 'claude' ? { configDirectory: join(db.directory, 'claude-profile') } : {}) },
    harnessProfileSelection: recorded.binding.profile }))
  const seeded = await seedAgent3(db.pool, db.directory, fixture, { run: false })
  const node = seeded.version.definition.nodes[0]!
  const configuration = seeded.configurations.find(value => value.agentId === node.agentId)!
  const context = { workspaceId: configuration.workspaceId, workflowId: seeded.scope.workflowId,
    workflowNodeId: node.id, agentId: configuration.agentId }
  const access = new PostgresAccessService(db.pool)
  const writer = await access.issue({ name: 'Remote chat writer', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
  const reader = await access.issue({ name: 'Remote chat reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000),
    grants: [{ actions: ['agent_chat:read', 'agents:read'], scope: {} }] })
  const repository = new PostgresAgentChatRepository(db.pool)
  const workflows = new PostgresWorkflowRepository(db.pool)
  const messages = new PostgresOperatorConversationRepository(db.pool)
  const conversation = await repository.ensureForControls(agentChatKey(context), { context,
    agentConfigurationVersionId: configuration.id, harness, origin: { kind: 'fresh' },
    workingDirectory: db.directory, runtimeDirectory: join(db.directory, 'chat') }, async () => {})
  const journal = await RemoteOperationJournal.open(join(db.directory, 'worker-operations.json'),
    { initializeNewInstallation: true })
  const frames: WorkerConversationRpcRequest[] = []
  const callbacks = workerConversationCallbacks({ currentBinding: () => recorded.connection,
    capture: () => ({ binding: recorded.connection, request: async (payload, options) => ({
      payload: await workerChats.bridge.handle(payload, recorded.connection,
        options?.signal ?? AbortSignal.timeout(10_000)),
    }) }) })
  const host = new WorkerConversationHost({ ...callbacks, currentBinding: () => recorded.connection,
    journal: journal.conversations, authorize: callbacks.authorize,
    allocate: async (binding, accepted) => ({ manager: provider.manager,
      start: async ({ correlationId, instructionsDelivered }) => {
        if (binding.owner.kind !== 'agent' || !('agentId' in accepted)) throw new Error('Agent fixture required')
        return { kind: 'agent-chat', configuration: accepted, conversationId: binding.owner.conversationId,
          workflowId: binding.owner.workflowId, workflowNodeId: binding.owner.workflowNodeId,
          workingDirectory: binding.workingDirectory, correlationId, instructionsDelivered,
          ...(binding.systemPrompt ? { systemPrompt: binding.systemPrompt } : {}) }
      }, nativeOwner: async session => ({ ...recorded.nativeOwner, sessionId: session.nativeSessionId }),
      close: async () => { await provider.manager.dispose?.() },
    }) })
  const channel = { binding: recorded.connection, request: async (raw: unknown) => {
    const request = WorkerConversationRpcRequestSchema.parse(raw)
    frames.push(request)
    return { payload: await host.handle(request, recorded.connection) }
  } }
  const profiles = { admit: async () => {
    const current = (await repository.get(conversation.id))!
    const selected = (await workflows.getAgentConfiguration(current.agent_configuration_version_id))!
    return { override: { configuration: selected.harness, target: recorded.binding.profile.target } }
  }, revalidate: async () => {} }
  // Installed-profile qualification is a fixture boundary; conversation authorization and persistence are real.
  const workerChats = createProductionWorkerConversations({ pool: db.pool,
    endpoint: () => ({ captureRequest: () => channel }), profiles, claudeProfiles: profiles,
    operators: messages, agents: repository, registry: {}, qualifications: {},
    suiteRevisions: {}, access, mcpForward: () => ({}),
  } as unknown as Parameters<typeof createProductionWorkerConversations>[0])
  const chat = new AgentChatService(db.pool, repository, messages, workflows, {
    getForWorkspace: async () => { throw new Error('Fresh Agent chat must not select a Run') },
    getExecution: async () => { throw new Error('Fresh Agent chat must not select an execution') },
    executionPages() { throw new Error('Fresh Agent chat must not select an execution') },
  }, (conversationId, selected, workingDirectory) => workerChats.create({ conversationId,
    configuration: selected, workingDirectory, appMcpAccess: 'none' }), db.directory)
  const commands = new PostgresCommandCoordinator(db.pool)
  const agents = new OperatorAgentMutationService(db.pool, commands, {
    qualifyConfiguration: async selected => ({ harness: selected.harness, version: 'recorded',
      authenticated: true, ready: true, model: selected.model, diagnostics: [] }),
  } as ConstructorParameters<typeof OperatorAgentMutationService>[2], { validateSelection: async () => {} })
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { agentChat: chat, commands, extensions: { agents } } as never } })
  const call = async (name: string, args: Record<string, unknown>, token = writer.token) =>
    graphRpc(app, token, 'tools/call', { name, arguments: { workspaceId: context.workspaceId, ...args } })
  const value = async (name: string, args: Record<string, unknown>) => {
    const response = await call(name, args)
    expect(response.result?.isError, JSON.stringify(response)).not.toBe(true)
    expect(response.error, JSON.stringify(response)).toBeUndefined()
    return graphRpcValue(response.result)
  }
  const send = async (content: string, delivery: 'completed' | 'failed' = 'completed') => {
    const requestId = randomUUID()
    const terminal = deferred()
    const events: Parameters<Parameters<typeof chat.events.subscribe>[1]>[0][] = []
    const unsubscribe = chat.events.subscribe(conversation.id, event => {
      events.push(event)
      if (event.data.requestId === requestId && ['completed', 'failed', 'canceled'].includes(String(event.data.delivery))) {
        terminal.resolve()
      }
    })
    try {
      await value('agent_chat_send', { request: { requestId, content, intent: 'next_turn',
        expectedConversationId: conversation.id, context } })
      await terminal.promise
      const turn = await repository.turn(conversation.id, requestId)
      expect(turn?.delivery, JSON.stringify(turn)).toBe(delivery)
      return { requestId, turn, events }
    } finally { unsubscribe() }
  }
  return { db, provider, configuration, context, conversation, repository, frames, chat, app,
    journal, writer, reader, call, value, send,
    async update(configuration: AgentConfigurationVersion['harness']) {
      return value('agent_update', { agentId: context.agentId, commandId: randomUUID(), configuration })
    },
    async close() {
      try { await chat.shutdown() }
      finally {
        try { await workerChats.close(); await host.shutdown(); await provider.manager.dispose?.(); await journal.close() }
        finally { try { await app.close() } finally { await db.close() } }
      }
    } }
}

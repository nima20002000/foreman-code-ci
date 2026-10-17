import { createHash, randomUUID } from 'node:crypto'
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, vi } from 'vitest'
import { z } from 'zod'
import { AgentConfigurationVersionSchema, HarnessExecutionSchema, withAdvancedDefaults, type AgentConfigurationVersion } from '@foreman-code/contracts'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { runChatStorageKey } from '../../src/modules/conversations/selectedRunChat.js'
import { createTestPool } from './testPool.mjs'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { ManagementActionSchema } from '@foreman-code/contracts/management'
import { AgentFileReadResultSchema, FileWithRevisionSchema, type MessageAttachmentRef } from '@foreman-code/contracts/files'
import { AcceptedWorkflowRunV3Schema, makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { WorkerConversationBindingSchema, WorkerConversationRpcRequestSchema,
  type WorkerConversationRpcRequest } from '@foreman-code/contracts/remote-execution-rpc'
import { buildApp } from '../../src/app.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { AgentChatService } from '../../src/modules/conversations/agentChat.js'
import { agentChatKey, PostgresAgentChatRepository } from '../../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../../src/modules/conversations/operatorChatRepository.js'
import { createProductionWorkerConversations } from '../../src/modules/conversations/workerProduction.js'
import { workerConversationFixture } from '../../src/modules/conversations/workerFixtures.test-support.js'
import { workerConversationCallbacks } from '../../src/modules/conversations/workerCallbacks.js'
import { WorkerConversationFiles } from '../../src/modules/conversations/workerFiles.js'
import { WorkerConversationHost, type WorkerConversationHostPorts } from '../../src/modules/conversations/workerHost.js'
import { RemoteOperationJournal } from '../../src/modules/runs/remote/operationJournal.js'
import { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { OperatorAgentMutationService, readAgentForReuse } from '../../src/modules/workspaces/operatorAgents.js'
import { localCodexChatHost } from '../../src/modules/harnesses/codexFiles/localHost.js'
import { postgresCodexChatFiles } from '../../src/modules/harnesses/codexFiles/chatAdmission.js'
import { productionCodexChatFiles } from '../../src/modules/harnesses/codexFiles/production.js'
import { registerProductionFileStorage } from '../../src/modules/files/production.js'
import { productionFileTools } from '../../src/modules/files/tools/production.js'
import type { ApiConfig } from '../../src/config.js'
import { withTransaction } from '../../src/infrastructure/transaction.js'
import { requireAuthorization } from '../../src/modules/access/policy.js'
import { HarnessInstanceSettingsRepository } from '../../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessOverrideService } from '../../src/modules/harnesses/instanceSettings/service.js'
import { graphHeaders, graphRpc, graphRpcValue } from '../eng04-graph-composition-fixture.js'
import { agent3Database, seedAgent3 } from './wave25Agent3.js'
import { remoteChatProvider } from './remoteChatProvider.js'
import { readWorkerConversationResults } from '../../src/modules/conversations/workerConversationResults.js'

export async function remoteAgentConversation(harness: 'codex' | 'claude', location: 'worker' | 'main' = 'worker',
  options: { runAttempts?: number; poolSize?: number } = {}) {
  const db = await agent3Database()
  const recorded = workerConversationFixture('agent', harness)
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  fixture.configurations = fixture.configurations.map(value => AgentConfigurationVersionSchema.parse({ ...value,
    harness: { ...recorded.configuration.harness, model: 'test-model',
      ...(harness === 'claude' ? { configDirectory: join(db.directory, 'claude-profile') } : {}) },
    ...(location === 'worker' ? { harnessProfileSelection: recorded.binding.profile } : {}) }))
  const seeded = await seedAgent3(db.pool, db.directory, fixture, { run: !!options.runAttempts })
  const sourceRun = options.runAttempts ? AcceptedWorkflowRunV3Schema.parse({ ...seeded.run,
    executionState: 'completed', outcome: 'succeeded', result: { outcome: 'succeeded', output: {} },
    finishedAt: seeded.createdAt }) : undefined
  const constrainedPool = options.poolSize ? createTestPool({ connectionString: db.databaseUrl,
    max: options.poolSize, connectionTimeoutMillis: 1000,
    options: '-c statement_timeout=10000 -c lock_timeout=5000' }) : undefined
  if (constrainedPool) db.pool = constrainedPool
  const node = seeded.version.definition.nodes[0]!
  const configuration = seeded.configurations.find(value => value.agentId === node.agentId)!
  const context = { workspaceId: configuration.workspaceId, workflowId: seeded.scope.workflowId,
    workflowNodeId: node.id, agentId: configuration.agentId, ...(options.runAttempts ? { runId: seeded.run.id } : {}) }
  const executions = Array.from({ length: options.runAttempts ?? 0 }, (_, index) => HarnessExecutionSchema.parse({
    id: randomUUID(), runId: seeded.run.id, workflowNodeId: node.id, agentId: configuration.agentId,
    agentConfigurationVersionId: configuration.id, attempt: index + 1, state: 'completed',
    input: {}, nativeSessionId: `run-session-${randomUUID()}`, workingDirectory: db.directory,
    createdAt: seeded.createdAt, startedAt: seeded.createdAt, finishedAt: seeded.createdAt,
    result: { outcome: 'succeeded' },
  }))
  for (const source of executions) {
    await db.pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
      values($1,$2,$3,$4,$5,$6::jsonb)`,
    [source.id,source.runId,source.workflowNodeId,source.agentId,source.attempt,JSON.stringify(source)])
  }
  const access = new PostgresAccessService(db.pool)
  const writer = await access.issue({ name: 'Remote chat writer', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ManagementActionSchema.options, scope: {} }] })
  const reader = await access.issue({ name: 'Remote chat reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000),
    grants: [{ actions: ['agent_chat:read', 'agents:read'], scope: {} }] })
  const repository = new PostgresAgentChatRepository(db.pool)
  const workflows = new PostgresWorkflowRepository(db.pool)
  const messages = new PostgresOperatorConversationRepository(db.pool)
  const execution = executions[0]
  const conversation = await repository.ensureForControls(execution ? runChatStorageKey(context, execution.id) : agentChatKey(context), { context,
    agentConfigurationVersionId: configuration.id, harness, origin: execution
      ? { kind: 'run_execution', runId: execution.runId, executionId: execution.id, sourceNativeSessionId: execution.nativeSessionId! }
      : { kind: 'fresh' },
    workingDirectory: db.directory, runtimeDirectory: join(db.directory, 'chat') }, async () => {})
  const journal = await RemoteOperationJournal.open(join(db.directory, 'worker-operations.json'),
    { initializeNewInstallation: true })
  const frames: WorkerConversationRpcRequest[] = []
  const callbacks = workerConversationCallbacks({ currentBinding: () => recorded.connection,
    capture: () => ({ binding: recorded.connection, request: async (payload, options) => ({
      payload: await workerChats.bridge.handle(payload, recorded.connection,
        options?.signal ?? AbortSignal.timeout(10_000)),
    }) }) })
  const lifetime = new AbortController()
  const workerFiles = new WorkerConversationFiles(callbacks)
  let source: WorkerConversationRpcRequest
  let attached: MessageAttachmentRef | undefined
  const receivedAttachments: string[] = []
  const provider = await remoteChatProvider(harness, db.directory, {
    ...(location === 'worker' ? { codexFiles: workerFiles.adapter({ source: () => source,
      host: () => localCodexChatHost(join(db.directory, 'worker-copies')),
      assertCurrent: async () => {}, signal: lifetime.signal }) } : {}),
    codexInput: async input => {
      for (const item of input as Array<{ type: string; text?: string }>) {
        for (const line of (item.text ?? '').split('\n').filter(line => line.startsWith('{"filename"'))) {
          const copy = JSON.parse(line) as { path: string }
          receivedAttachments.push(await readFile(copy.path, 'utf8'))
        }
      }
    },
    claudeMessage: async (sessionId, messageId) => {
      if (!attached) return
      const request = source
      if (request.method !== 'conversation.initial-turn' && request.method !== 'conversation.start-turn') {
        throw new Error('An admitted Claude message is required')
      }
      const admission = z.object({ ownerPrincipalId: z.string(), attemptId: z.string() }).parse(
        await callbacks.claudeAuthority(request, { phase: 'admission' }, lifetime.signal))
      await vi.waitFor(async () => {
        const current = (await repository.get(conversation.id))!
        const turn = await repository.turn(conversation.id, current.active_request_id!)
        expect(turn?.nativeSubmission?.nativeMessageId).toBe(messageId)
      }, { timeout: 5000 })
      const result = AgentFileReadResultSchema.parse(await callbacks.claudeAuthority(request, {
        phase: 'file', identity: { ...admission, nativeSessionId: sessionId, nativeMessageId: messageId,
          clientCorrelationId: request.correlationId, generation: 'recorded-query', toolUseId: randomUUID() },
        operation: 'files.read', args: attached,
      }, lifetime.signal))
      if (result.status !== 'ready') throw new Error('The remote attachment must be readable')
      receivedAttachments.push(Buffer.from(result.contentBase64, 'base64').toString('utf8'))
    },
  })
  const providers = [provider]
  const providersByConversation = new Map([[conversation.id, provider]])
  const nativeManagers = new Map([[conversation.id, provider.manager]])
  const closedManagers = new WeakSet<import('../../src/modules/harnesses/port.js').NativeHarnessSessionManager>()
  const nativeManager = async (conversationId: string) => {
    const existing = nativeManagers.get(conversationId)
    if (existing) return existing
    const created = await remoteChatProvider(harness, db.directory)
    providers.push(created)
    providersByConversation.set(conversationId, created)
    nativeManagers.set(conversationId, created.manager)
    return created.manager
  }
  const prepareProvider = async (conversationId: string) => {
    await nativeManager(conversationId)
    return providersByConversation.get(conversationId)!
  }
  const allocate: WorkerConversationHostPorts['allocate'] = async (binding, accepted) => {
      const manager = await nativeManager(binding.owner.conversationId)
      return { manager,
      start: async ({ correlationId, instructionsDelivered }) => {
        if (binding.owner.kind !== 'agent' || !('agentId' in accepted)) throw new Error('Agent fixture required')
        return { kind: 'agent-chat', configuration: accepted, conversationId: binding.owner.conversationId,
          workflowId: binding.owner.workflowId, workflowNodeId: binding.owner.workflowNodeId,
          workingDirectory: binding.workingDirectory, correlationId, instructionsDelivered,
          ...(binding.systemPrompt ? { systemPrompt: binding.systemPrompt } : {}) }
      }, nativeOwner: async session => ({ ...recorded.nativeOwner, sessionId: session.nativeSessionId }),
      close: async () => { await manager.dispose!(); closedManagers.add(manager) },
    } }
  const host = new WorkerConversationHost({ ...callbacks, currentBinding: () => recorded.connection,
    journal: journal.conversations, authorize: callbacks.authorize, allocate,
    recover: async (record, accepted, connection, signal, request) => {
      const previousManager = nativeManagers.get(request.binding.owner.conversationId)
      if (!previousManager || !closedManagers.has(previousManager)
        || !record.session || !record.nativeOwner || !record.creation) {
        throw new Error('Recorded recovery requires a confirmed native runtime release')
      }
      const current = await prepareProvider(request.binding.owner.conversationId)
      nativeManagers.set(request.binding.owner.conversationId, current.restartManager())
      const allocation = await allocate(request.binding, accepted, connection, signal)
      const preferences = 'preferences' in request ? request.preferences : record.desiredPreferences
      if (preferences) await allocation.manager.configureSessionPreferences?.(preferences)
      const start = await allocation.start({ correlationId: record.creation.operationId, instructionsDelivered: true })
      const session = await allocation.manager.attachSession(record.session, start, signal)
      expect(session).toEqual(record.session)
      const recovered = await readWorkerConversationResults(record, allocation.manager, signal,
        allocation.manager.readCompaction
          ? state => allocation.manager.readCompaction!(session, start, state, signal) : undefined)
      for (const turn of recovered.recoveredTurns) {
        await journal.conversations.finishTurn(record.binding, turn.correlationId, turn.result)
      }
      for (const state of recovered.recoveredCompactions) await journal.conversations.compactProgress(record.binding, state)
      const owner = await allocation.nativeOwner(session)
      const transition = request.method === 'conversation.open' && request.previousConfiguration
        ? { targetBinding: request.binding, previousConfiguration: request.previousConfiguration, configuration: accepted }
        : undefined
      await journal.conversations.recoveredOwner(record.binding, connection, record.nativeOwner, owner, transition)
      return allocation
    },
  })
  const channel = { binding: recorded.connection, request: async (raw: unknown) => {
    const request = WorkerConversationRpcRequestSchema.parse(raw)
    frames.push(request)
    if (request.method === 'conversation.file-copy') return { payload: await workerFiles.copy(request, lifetime.signal) }
    if (request.method === 'conversation.initial-turn' || request.method === 'conversation.start-turn') source = request
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
    fileService: () => productionFileTools(app),
    files: (conversationId: string) =>
      async ({ host: fileHost, assertHost, ...turn }: Parameters<import('../../src/modules/conversations/mainWorkerFiles.js').PrepareWorkerFiles>[0]) => {
        const admissions = postgresCodexChatFiles(db.pool, () => storage, async () => fileHost,
          { assertCurrent: assertHost })
        return productionCodexChatFiles(() => app, conversationId, admissions).prepare(turn)
      },
  } as unknown as Parameters<typeof createProductionWorkerConversations>[0])
  const chat = new AgentChatService(db.pool, repository, messages, workflows, {
    getForWorkspace: async (workspaceId, runId) => {
      if (!options.runAttempts) throw new Error('Fresh Agent chat must not select a Run')
      return workspaceId === context.workspaceId && runId === seeded.run.id
        ? sourceRun : undefined
    },
    getExecution: async id => {
      if (!options.runAttempts) throw new Error('Fresh Agent chat must not select an execution')
      return executions.find(item => item.id === id)
    },
    async *executionPages(runId) {
      if (!options.runAttempts) throw new Error('Fresh Agent chat must not select an execution')
      if (runId === seeded.run.id) yield executions
    },
  }, (conversationId, selected, workingDirectory) => location === 'main' ? nativeManager(conversationId)
    : workerChats.create({ conversationId, configuration: selected, workingDirectory, appMcpAccess: 'none' }), db.directory)
  const commands = new PostgresCommandCoordinator(db.pool)
  const profileRepository = new HarnessInstanceSettingsRepository(db.pool)
  const profileService = new HostHarnessOverrideService(profileRepository, commands, {
    // Physical installation admission is recorded; the actual profile/configuration validator remains active.
    authorize: async (principal, action) => { requireAuthorization(principal, action) },
  }, async () => null)
  const saveProfile = async (selected: AgentConfigurationVersion['harness']) => withTransaction(db.pool, async client => {
    const original = await profileRepository.latest(client, recorded.binding.profile.instanceId)
    const previous = original?.driverId === selected.harness ? original : undefined
    const instanceId = original && !previous ? randomUUID() : recorded.binding.profile.instanceId
    return profileRepository.append(client, writer.principal.id, previous?.revision ?? 0, {
      instanceId, instanceRevision: previous ? String(previous.revision + 1)
        : recorded.binding.profile.instanceRevision, revision: (previous?.revision ?? 0) + 1,
      target: recorded.binding.profile.target, presetId: 'recorded', enabled: true, driverId: selected.harness,
      configuration: withAdvancedDefaults(selected), configurationFingerprint: commandInputHash(withAdvancedDefaults(selected)),
      qualification: 'unqualified',
    })
  })
  await saveProfile(configuration.harness)
  const agents = new OperatorAgentMutationService(db.pool, commands, {
    qualifyConfiguration: async selected => ({ harness: selected.harness, version: 'recorded',
      authenticated: true, ready: true, structuredEvents: true, supportsResume: true,
      supportsCancellation: true, supportsWorkingDirectory: true, supportsStartupPrompt: true,
      supportedNativeTools: [], supportedSettings: [], unsupportedCapabilities: [] }),
  }, profileService)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { agentChat: chat, commands, extensions: { agents } } as never } })
  const storage = registerProductionFileStorage(app, db.pool, {
    fileStorageRoot: join(db.directory, 'vault'), workspaceStorageRoot: join(db.directory, 'workspaces'),
    harnesses: { workspaceRoot: join(db.directory, 'runtime') },
  } as ApiConfig)
  const call = async (name: string, args: Record<string, unknown>, token = writer.token) =>
    graphRpc(app, token, 'tools/call', { name, arguments: { workspaceId: context.workspaceId, ...args } }, randomUUID())
  const value = async (name: string, args: Record<string, unknown>) => {
    const response = await call(name, args)
    expect(response.result?.isError, JSON.stringify(response)).not.toBe(true)
    expect(response.error, JSON.stringify(response)).toBeUndefined()
    return graphRpcValue(response.result)
  }
  const send = async (content: string, delivery: 'completed' | 'failed' = 'completed',
    attachments: MessageAttachmentRef[] = [], conversationId = conversation.id) => {
    const requestId = randomUUID()
    const events: Parameters<Parameters<typeof chat.events.subscribe>[1]>[0][] = []
    const unsubscribe = chat.events.subscribe(conversationId, event => { events.push(event) })
    try {
      await value('agent_chat_send', { request: { requestId, content, intent: 'next_turn',
        expectedConversationId: conversationId, context, attachments } })
      await vi.waitFor(async () => {
        const state = AgentChatStateSchema.parse(await value('agent_chat_read', { query: context, conversationId }))
        const turn = state.turns.find(value => value.requestId === requestId)
        expect(['completed', 'failed', 'canceled'], JSON.stringify(turn)).toContain(turn?.delivery)
      }, { timeout: 5000 })
      const turn = await repository.turn(conversationId, requestId)
      expect(turn?.delivery, JSON.stringify(turn)).toBe(delivery)
      return { requestId, turn, events }
    } finally { unsubscribe() }
  }
  return { db, provider, providers, prepareProvider, executions, configuration, context, conversation, repository, frames, chat, app,
    journal, writer, reader, call, value, send, receivedAttachments,
    drainWorker: () => host.drainForUpdate(),
    async snapshot() {
      const row = (await repository.get(conversation.id))!
      const native = row.native_session_id && row.provider_version ? await provider.manager.history({
        harness: row.harness, nativeSessionId: row.native_session_id, providerVersion: row.provider_version,
      }) : undefined
      const binding = (await db.pool.query<{ worker_conversation_binding: unknown }>(
        'select worker_conversation_binding from operator_conversations where id=$1', [conversation.id])).rows[0]!
      const record = binding.worker_conversation_binding ? await journal.conversations.read(
        WorkerConversationBindingSchema.parse(binding.worker_conversation_binding)) : undefined
      return { requestId: row.active_request_id, nativeTurnId: row.active_native_turn_id,
        turnState: row.turn_state, nativeCalls: provider.calls, modes: provider.modes,
        frames: frames.map(frame => ({ method: frame.method,
          correlationId: 'correlationId' in frame ? frame.correlationId : undefined })),
        workerTurns: record?.turns, nativeEvents: native?.events.map(event => ({ type: event.type, payload: event.payload })) }
    },
    async binding() {
      const row = (await db.pool.query<{ worker_conversation_binding: unknown }>(
        'select worker_conversation_binding from operator_conversations where id=$1', [conversation.id])).rows[0]!
      return WorkerConversationBindingSchema.parse(row.worker_conversation_binding)
    },
    async upload(bytes: Buffer) {
      const requestId = randomUUID()
      const url = `/api/workspaces/${context.workspaceId}/agent-chat/conversations/${conversation.id}/files/uploads`
      const headers = graphHeaders(writer.token)
      const allocation = await app.inject({ method: 'POST', url, headers, payload: {
        requestId, filename: 'attached.md', mediaType: 'text/markdown', byteSize: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      } })
      expect(allocation.statusCode, allocation.body).toBe(201)
      const uploaded = await app.inject({ method: 'PUT', url: `${url}/${requestId}`,
        headers: { ...headers, 'content-type': 'application/octet-stream' }, payload: bytes })
      expect(uploaded.statusCode, uploaded.body).toBe(200)
      const finalized = await app.inject({ method: 'POST', url: `${url}/${requestId}/finalize`, headers, payload: {} })
      expect(finalized.statusCode, finalized.body).toBe(200)
      const file = FileWithRevisionSchema.parse(finalized.json().value)
      attached = { fileId: file.file.fileId, revisionId: file.revision.revisionId }
      return attached
    },
    async update(configuration: AgentConfigurationVersion['harness'], options: { matchingProfile?: boolean } = {}) {
      const current = await withTransaction(db.pool, client =>
        readAgentForReuse(client, writer.principal, context.workspaceId, context.agentId))
      const selected = options.matchingProfile ? await saveProfile(configuration) : undefined
      return value('agent_update', { agentId: context.agentId, commandId: randomUUID(), configuration,
        expectedRevision: current.baseRevision, expectedConfigurationVersionId: current.agent.configurationVersionId,
        ...(selected ? { harnessProfileSelection: { instanceId: selected.instanceId,
          instanceRevision: selected.instanceRevision, target: selected.target } } : {}) })
    },
    async close() {
      provider.releaseReply()
      try { await chat.shutdown() }
      finally {
        try {
          await workerChats.close(); await host.shutdown()
          for (const current of providers) await current.manager.dispose?.()
          lifetime.abort(); await workerFiles.close(); await journal.close()
        }
        finally {
          try { await app.close() }
          finally {
            try { await constrainedPool?.end() }
            finally { await db.close() }
          }
        }
      }
    } }
}

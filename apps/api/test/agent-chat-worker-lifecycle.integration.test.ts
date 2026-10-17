import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { buildApp } from '../src/app.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { AgentChatService } from '../src/modules/conversations/agentChat.js'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { PostgresOperatorConversationRepository } from '../src/modules/conversations/operatorChatRepository.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { workerClaudeReplacementFixture } from '../src/modules/conversations/workerClaudeReplacement.test-support.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { readSystemPromptSetting } from '../src/modules/settings/foundation.js'
import { agent3Database, seedAgent3 } from './helpers/wave25Agent3.js'
import { graphHeaders, graphRpc, graphRpcValue } from './eng04-graph-composition-fixture.js'
import { deferred } from './helpers/deferred.js'

async function fixture() {
  const db = await agent3Database()
  const recorded = workerConversationFixture('agent', 'claude')
  const definition = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  definition.configurations = definition.configurations.map(value => AgentConfigurationVersionSchema.parse({ ...value,
    harness: recorded.configuration.harness, harnessProfileSelection: recorded.binding.profile }))
  let worker: Awaited<ReturnType<typeof workerClaudeReplacementFixture>> | undefined
  let chat: AgentChatService | undefined
  let app: ReturnType<typeof buildApp> | undefined
  const cleanup = async () => {
    worker?.reconnect()
    await chat?.shutdown()
    await app?.close()
    await worker?.close()
    await db.close()
  }
  try {
    const seeded = await seedAgent3(db.pool, db.directory, definition, { run: false })
    const node = seeded.version.definition.nodes[0]!
    const configuration = seeded.configurations.find(value => value.agentId === node.agentId)!
    const context = { workspaceId: seeded.scope.workspaceId, workflowId: seeded.scope.workflowId,
      workflowNodeId: node.id, agentId: node.agentId }
    const query = { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId }
    const access = new PostgresAccessService(db.pool)
    const credential = (actions: ['agent_chat:read'] | ['agent_chat:read', 'agent_chat:write']) => access.issue({
      name: 'Worker chat caller', audience: 'operator', expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions, scope: {} }] })
    const writer = await credential(['agent_chat:read', 'agent_chat:write'])
    const reader = await credential(['agent_chat:read'])
    const denied = await access.issue({ name: 'Unrelated workspace caller', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000),
      grants: [{ actions: ['agent_chat:read'], scope: { workspaceIds: ['other-workspace'] } }] })
    const repository = new PostgresAgentChatRepository(db.pool)
    const conversation = await repository.ensureForControls(agentChatKey(context), { context,
      agentConfigurationVersionId: configuration.id, harness: 'claude', origin: { kind: 'fresh' },
      workingDirectory: db.directory, runtimeDirectory: join(db.directory, 'worker-chat') }, async () => {})
    worker = await workerClaudeReplacementFixture({ ...recorded, configuration,
      binding: { ...recorded.binding, workingDirectory: db.directory,
        systemPrompt: await readSystemPromptSetting(db.pool), owner: { kind: 'agent',
          conversationId: conversation.id, workspaceId: configuration.workspaceId, workflowId: context.workflowId,
          workflowNodeId: node.id, agentId: node.agentId, configurationVersionId: configuration.id,
          configurationHash: commandInputHash(configuration) } } })
    chat = new AgentChatService(db.pool, repository, new PostgresOperatorConversationRepository(db.pool),
      new PostgresWorkflowRepository(db.pool), {
        getForWorkspace: async () => { throw new Error('This chat has no Run.') },
        getExecution: async () => { throw new Error('This chat has no execution.') },
        executionPages: () => { throw new Error('This chat has no execution pages.') },
      }, () => worker!.createManager(), db.directory)
    app = buildApp({ logger: false,
      readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
      operator: { access, services: { agentChat: chat, commands: new PostgresCommandCoordinator(db.pool) } as never } })
    const call = (token: string, name: string, args: Record<string, unknown>) => graphRpc(app!, token, 'tools/call', {
      name, arguments: { workspaceId: context.workspaceId, ...args },
    })
    const complete = deferred()
    const unsubscribe = chat.events.subscribe(conversation.id, event => {
      if (event.data.requestId === 'initial-message' && event.data.delivery === 'completed') complete.resolve()
    })
    try {
      const sent = await call(writer.token, 'agent_chat_send', { request: { requestId: 'initial-message',
        content: 'Remember this message', intent: 'next_turn', expectedConversationId: conversation.id, context: query } })
      expect(sent.result?.isError).not.toBe(true)
      await complete.promise
    } finally { unsubscribe() }
    const read = async () => {
      const response = await call(reader.token, 'agent_chat_read', { query })
      expect(response.result?.isError).not.toBe(true)
      return AgentChatStateSchema.parse(graphRpcValue(response.result))
    }
    const root = `/api/workspaces/${context.workspaceId}/agent-chat`
    return { db, worker, chat, app, repository, conversation, query, reader, denied, call, read, root, cleanup }
  } catch (error) { await cleanup(); throw error }
}

it.each(['transport', 'unavailable'] as const)(
  'serves persisted Agent chat state and SSE bootstrap with an offline %s observation through HTTP and MCP', async failure => {
  const f = await fixture()
  try {
    const before = await f.read()
    expect(before.messages.some(message => message.role === 'user')).toBe(true)
    f.worker.disconnect(failure)
    const denied = await f.call(f.denied.token, 'agent_chat_read', { query: f.query })
    expect(denied.error || denied.result?.isError).toBeTruthy()
    const offline = await f.read()
    expect(offline.messages).toEqual(before.messages)
    expect(offline.turns).toEqual(before.turns)
    expect(offline.activitySnapshot?.observation).toMatchObject({ status: 'unavailable',
      lastError: expect.stringContaining(failure === 'transport' ? 'transport' : 'WORKER_CONVERSATION_UNAVAILABLE'), consecutiveFailures: 1 })
    const http = await f.app.inject({ method: 'GET', url: `${f.root}?${new URLSearchParams(f.query)}`,
      headers: graphHeaders(f.reader.token) })
    expect(http.statusCode).toBe(200)
    expect(AgentChatStateSchema.parse(http.json()).messages).toEqual(before.messages)
    const address = f.app.server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP listener required')
    const controller = new AbortController()
    try {
      const response = await fetch(`http://127.0.0.1:${address.port}${f.root}/conversations/${f.conversation.id}/events`, {
        headers: graphHeaders(f.reader.token), signal: controller.signal })
      expect(response.status).toBe(200)
      const stream = response.body!.getReader()
      const first = await stream.read()
      const frame = new TextDecoder().decode(first.value)
      expect(frame).toContain('event: snapshot')
      const snapshot = JSON.parse(frame.split('\n').find(line => line.startsWith('data:'))!.slice(5))
      expect(snapshot.data.messages).toEqual(before.messages)
      expect(snapshot.data.activitySnapshot.observation.status).toBe('unavailable')
      await stream.cancel()
    } finally { controller.abort() }
    expect((await f.repository.state(f.conversation.id))?.messages).toEqual(before.messages)
    f.worker.reconnect()
    expect((await f.read()).activitySnapshot?.observation).toMatchObject({ status: 'available',
      consecutiveFailures: 0, lastError: null, lastSuccess: expect.any(String) })
    expect(f.worker.offers).toHaveLength(1)
  } finally { await f.cleanup() }
})

it('releases a settled Worker runtime during graceful Main shutdown while retaining its saved session', async () => {
  const f = await fixture()
  try {
    const before = (await f.worker.journal.conversations.read(f.worker.binding))!
    expect(f.worker.launches).toHaveLength(1)
    expect(f.worker.launches[0]?.lifecycle).toBe('active')
    await f.chat.shutdown()
    const released = (await f.worker.journal.conversations.read(f.worker.binding))!
    expect(released.runtimeReleased).toBe(true)
    expect(released.closed).toBe(false)
    expect(released.session).toEqual(before.session)
    expect(released.turns).toEqual(before.turns)
    expect(f.worker.launches[0]).toMatchObject({ lifecycle: 'closed', closureEvidence: 'native_exit_removed_cgroup' })
    expect((await f.repository.get(f.conversation.id))?.native_session_id).toBe(before.session!.nativeSessionId)
    await f.chat.shutdown()
    expect(f.worker.offers).toHaveLength(1)
  } finally { await f.cleanup() }
})

async function promptly<T>(read: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined
  try {
    return await Promise.race([read, new Promise<never>((_resolve, reject) => {
      timer = setTimeout(() => reject(new Error('Persisted snapshot waited for the stalled Worker')), 2_000)
    })])
  } finally { clearTimeout(timer) }
}

it('bounds stalled Worker refreshes for persisted MCP, HTTP and SSE snapshots', async () => {
  const f = await fixture()
  try {
    const before = await f.read()
    f.worker.disconnect('stalled')
    const offline = await promptly(f.read())
    expect(offline.messages).toEqual(before.messages)
    expect(offline.activitySnapshot?.observation).toMatchObject({ status: 'unavailable',
      lastError: expect.stringContaining('TimeoutError') })
    const http = await promptly(f.app.inject({ method: 'GET', url: `${f.root}?${new URLSearchParams(f.query)}`,
      headers: graphHeaders(f.reader.token) }))
    expect(http.statusCode).toBe(200)
    expect(AgentChatStateSchema.parse(http.json()).messages).toEqual(before.messages)
    const address = f.app.server.address()
    if (!address || typeof address === 'string') throw new Error('HTTP listener required')
    const controller = new AbortController()
    try {
      const response = await promptly(fetch(`http://127.0.0.1:${address.port}${f.root}/conversations/${f.conversation.id}/events`, {
        headers: graphHeaders(f.reader.token), signal: controller.signal }))
      expect(response.status).toBe(200)
      const stream = response.body!.getReader()
      const first = await promptly(stream.read())
      const frame = new TextDecoder().decode(first.value)
      expect(frame).toContain('event: snapshot')
      const snapshot = JSON.parse(frame.split('\n').find(line => line.startsWith('data:'))!.slice(5))
      expect(snapshot.data.messages).toEqual(before.messages)
      expect(snapshot.data.activitySnapshot.observation.status).toBe('unavailable')
      await stream.cancel()
    } finally { controller.abort() }
    f.worker.reconnect()
    expect((await f.read()).activitySnapshot?.observation?.status).toBe('available')
    expect(f.worker.offers).toHaveLength(1)
  } finally { await f.cleanup() }
})

import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { ActivityChangeEnvelopeV1Schema, SessionControlStateSchema, type HarnessConfiguration } from '@foreman-code/contracts'
import { AgentMutationResultSchema } from '@foreman-code/contracts/management'
import { remoteAgentConversation } from './helpers/remoteAgentConversation.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'
import { assertAgentNewConversation } from './helpers/agentNewConversation.js'

function changedSettings(configuration: HarnessConfiguration, field: 'model' | 'effort' | 'account'): HarnessConfiguration {
  if (configuration.harness === 'opencode') throw new Error('Supported chat harness required')
  if (field === 'model') return { ...configuration, model: 'changed-model' }
  if (field === 'account') return { ...configuration, accountId: randomUUID() }
  if (configuration.harness === 'codex') return { ...configuration, reasoningEffort: 'high' }
  if (configuration.harness === 'claude') return { ...configuration, effort: 'high' }
  throw new Error('Supported chat harness required')
}

it.each(['codex', 'claude'] as const)(
  'sends, streams and persists a remote %s Agent reply through authenticated MCP', async harness => {
    const f = await remoteAgentConversation(harness)
    const id = f.conversation.id
    try {
      const denied = await f.call('agent_chat_send', { request: { requestId: randomUUID(), content: 'Denied',
        intent: 'next_turn', expectedConversationId: id, context: f.context } }, f.reader.token)
      expect(denied.error || denied.result?.isError).toBeTruthy()
      expect(f.provider.prompts).toHaveLength(0)
      f.provider.holdReply()
      let streamed = false
      const unsubscribe = f.chat.events.subscribe(id, event => {
        if (event.type === 'delta') streamed = true
      })
      const sending = f.send('Read the task and reply')
      try {
        await vi.waitFor(() => expect(streamed).toBe(true), { timeout: 5000 })
        const partial = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
        expect(partial.messages.some(message => message.role === 'assistant'
          && message.content === 'Remote streamed answer' && message.nativeMessageComplete === false)).toBe(true)
      } catch (error) {
        console.error('Remote stream observation', JSON.stringify(await f.snapshot()))
        throw error
      } finally {
        f.provider.releaseReply()
        await sending
        unsubscribe()
      }
      const first = await sending
      expect(first.events.some(event => event.type === 'delta'), JSON.stringify(first.events)).toBe(true)
      const read = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
      expect(read.messages.some(message => message.role === 'assistant'
        && message.content === 'Remote streamed answer')).toBe(true)
      expect(read.conversation?.harness).toBe(harness)
      expect(f.frames.some(frame => frame.method === 'conversation.history' && frame.waitForEvents)).toBe(true)
    } finally { await f.close() }
  }, 30_000)

it('streams and persists every remote Claude tool round before transcript entries and final messages', async () => {
  const f = await remoteAgentConversation('claude')
  const deltas: string[] = []
  const unsubscribe = f.chat.events.subscribe(f.conversation.id, event => {
    if (event.type !== 'delta') return
    const change = ActivityChangeEnvelopeV1Schema.parse(event.data.activityChange).change
    if (change.kind === 'text.append' && change.finality === 'provisional') deltas.push(change.text)
  })
  f.provider.holdClaudeToolRounds()
  const sending = f.send('Read files in two tool rounds and explain the result')
  try {
    for (let round = 0; round < 3; round++) {
      const text = `Remote tool round ${round + 1}`
      await vi.waitFor(() => expect(deltas).toContain(text), { timeout: 5000 })
      const partial = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
      expect(partial.messages.some(message => message.role === 'assistant'
        && message.content === text && message.nativeMessageComplete === false)).toBe(true)
      expect(f.provider.persistedClaudeReplies).toBe(0)
      f.provider.releaseClaudeToolRound(round)
    }
    await sending
    const complete = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
    for (const text of ['Remote tool round 1', 'Remote tool round 2', 'Remote tool round 3']) {
      expect(complete.messages.some(message => message.role === 'assistant'
        && message.content === text && message.nativeMessageComplete === true)).toBe(true)
    }
    expect(f.provider.persistedClaudeReplies).toBe(3)
  } finally {
    f.provider.releaseReply()
    await sending
    unsubscribe()
    await f.close()
  }
}, 30_000)

it('finishes remote Codex compaction when history completes before native notifications', async () => {
  const f = await remoteAgentConversation('codex')
  try {
    await f.send('Establish the remote session')
    f.provider.holdCompactionNotifications()
    const before = SessionControlStateSchema.parse(await f.value('agent_chat_controls_get', {
      conversationId: f.conversation.id,
    }))
    const compact = SessionControlStateSchema.parse(await f.value('agent_chat_controls_update', {
      conversationId: f.conversation.id, request: { kind: 'compact', requestId: randomUUID(),
        expectedRevision: before.revision },
    }))
    expect(compact.compaction?.status).toBe('completed')
    expect(f.provider.compactions).toBe(1)
    f.provider.releaseCompactionNotifications()
    let drained = false
    const draining = f.drainWorker().then(() => { drained = true })
    await vi.waitFor(() => expect(drained).toBe(true))
    await draining
    await f.send('Continue after compaction')
    expect(f.frames.filter(frame => frame.method === 'conversation.compact')).toHaveLength(1)
  } finally { await f.close() }
}, 30_000)

it.each(['codex', 'claude'] as const)(
  'applies Plan and Plan off to the next remote %s turn', async harness => {
    const f = await remoteAgentConversation(harness)
    const id = f.conversation.id
    try {
      await f.send('Establish the remote session')
      const controls = () => f.value('agent_chat_controls_get', { conversationId: id })
        .then(value => SessionControlStateSchema.parse(value))
      const initial = await controls()
      expect(initial.capabilities.plan.supported).toBe(true)
      const mode = async (mode: 'plan' | 'regular') => {
        const before = await controls()
        console.info('Remote mode requested', harness, mode)
        const changed = SessionControlStateSchema.parse(await f.value('agent_chat_controls_update', { conversationId: id,
          request: { kind: 'mode', mode, requestId: randomUUID(), expectedRevision: before.revision } }))
        console.info('Remote mode saved', harness, mode)
        return changed
      }
      expect((await mode('plan')).desiredMode).toBe('plan')
      const diagnostic = setTimeout(async () => {
        console.error('Remote planned turn observation', JSON.stringify(await f.snapshot()))
      }, 5000)
      try { await f.send('Plan the next task') }
      finally { clearTimeout(diagnostic) }
      expect(f.provider.modes.at(-1)).toBe('plan')
      expect((await controls()).appliedMode).toBe('plan')
      expect((await mode('regular')).desiredMode).toBe('regular')
      await f.send('Continue in regular mode')
      expect(f.provider.modes.at(-1)).toBe('default')
      expect((await controls()).appliedMode).toBe('regular')
    } finally { await f.close() }
  }, 30_000)

it.each(['codex', 'claude'] as const)(
  'compacts a remote %s Agent session through the Worker harness', async harness => {
    const f = await remoteAgentConversation(harness)
    const id = f.conversation.id
    try {
      await f.send('Establish the remote session')
      const controls = () => f.value('agent_chat_controls_get', { conversationId: id })
        .then(value => SessionControlStateSchema.parse(value))
      const beforeCompact = await controls()
      expect(beforeCompact.capabilities.compact.supported).toBe(true)
      const compact = SessionControlStateSchema.parse(await f.value('agent_chat_controls_update', {
        conversationId: id, request: { kind: 'compact', requestId: randomUUID(),
          expectedRevision: beforeCompact.revision },
      }))
      expect(['accepted', 'running', 'completed']).toContain(compact.compaction?.status)
      await vi.waitFor(async () => expect((await controls()).compaction?.status).toBe('completed'))
      expect(f.provider.compactions).toBe(1)
      expect(f.frames.filter(frame => frame.method === 'conversation.compact')).toHaveLength(1)
    } finally { await f.close() }
  }, 30_000)

it.each(['codex', 'claude'] as const)(
  'starts a fresh remote %s Agent conversation with /new and retains history', async harness => {
    const f = await remoteAgentConversation(harness)
    try {
      await assertAgentNewConversation(f)
      const openMethod = harness === 'codex' ? 'conversation.open' : 'conversation.initial-turn'
      expect(f.frames.filter(frame => frame.method === openMethod)).toHaveLength(2)
      expect(f.frames.some(frame => frame.method === 'conversation.release-runtime')).toBe(true)
    } finally { await f.close() }
  }, 30_000)

it.each((['codex', 'claude'] as const).flatMap(harness =>
  (['model', 'effort', 'account'] as const).map(field => ({ harness, field }))))(
  'persists a remote $harness Agent $field change but rejects its next turn at the old Worker binding', async ({ harness, field }) => {
    const f = await remoteAgentConversation(harness)
    try {
      await f.send('Establish the remote session')
      const original = (await f.repository.get(f.conversation.id))!
      const originalBinding = await f.binding()
      const before = f.provider.prompts.length
      const changed = changedSettings(f.configuration.harness, field)
      const denied = await f.call('agent_update', { agentId: f.context.agentId,
        commandId: randomUUID(), configuration: changed, expectedRevision: 1,
        expectedConfigurationVersionId: f.configuration.id }, f.reader.token)
      expect(denied.error || denied.result?.isError).toBeTruthy()
      const chatEdit = await f.call('agent_update', { agentId: f.context.agentId,
        commandId: randomUUID(), configuration: changed, expectedRevision: 1,
        expectedConfigurationVersionId: f.configuration.id })
      expect(chatEdit.error || chatEdit.result?.isError).toBeTruthy()
      expect(JSON.stringify(chatEdit)).toContain('HARNESS_PROFILE_SELECTION_CONFLICT')
      expect((await f.repository.get(f.conversation.id))?.agent_configuration_version_id).toBe(f.configuration.id)
      const update = AgentMutationResultSchema.parse(await f.update(changed, { matchingProfile: true }))
      expect(update.value.agent.harnessConfiguration).toEqual(changed)
      const failed = await f.send('Use the saved model on this turn', 'failed')
      expect(failed.turn?.error).toMatchObject({ code: 'WORKER_CONVERSATION_UNAVAILABLE' })
      expect(failed.turn?.error?.message).toBe('The original worker conversation binding changed.')
      expect(f.provider.prompts).toHaveLength(before)
      const saved = (await f.repository.get(f.conversation.id))!
      expect(saved.agent_configuration_version_id).toBe(update.value.agent.configurationVersionId)
      expect(await f.binding()).toEqual(originalBinding)
      expect(saved.native_session_id).toBe(field === 'account' ? null : original.native_session_id)
    } finally { await f.close() }
  }, 30_000)

it.each(['codex', 'claude'] as const)(
  'rejects a remote %s Agent harness change at the retained Worker binding after saving it', async harness => {
    const f = await remoteAgentConversation(harness)
    try {
      await f.send('Establish the remote session')
      const original = (await f.repository.get(f.conversation.id))!
      const originalBinding = await f.binding()
      const changed = workerConversationFixture('agent', harness === 'codex' ? 'claude' : 'codex').configuration.harness
      const update = AgentMutationResultSchema.parse(await f.update(changed, { matchingProfile: true }))
      expect(update.value.agent.harness).toBe(changed.harness)
      const failed = await f.send('Use the saved harness on this turn', 'failed')
      expect(failed.turn?.error).toMatchObject({ code: 'WORKER_CONVERSATION_UNAVAILABLE',
        message: 'The original worker conversation binding changed.' })
      expect(f.provider.prompts).toHaveLength(1)
      const saved = (await f.repository.get(f.conversation.id))!
      expect(saved.agent_configuration_version_id).toBe(update.value.agent.configurationVersionId)
      expect(await f.binding()).toEqual(originalBinding)
      expect(saved.native_session_id).toBeNull()
      expect(original.native_session_id).toBeTruthy()
    } finally { await f.close() }
  }, 30_000)

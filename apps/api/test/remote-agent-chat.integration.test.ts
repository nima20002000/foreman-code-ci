import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { DEFAULT_HARNESS_DEFAULTS, SessionControlStateSchema } from '@foreman-code/contracts'
import { AgentMutationResultSchema } from '@foreman-code/contracts/management'
import { remoteAgentConversation } from './helpers/remoteAgentConversation.js'

it.each(['codex', 'claude'] as const)(
  'sends, streams, persists and controls a remote %s Agent through authenticated MCP', async harness => {
    const f = await remoteAgentConversation(harness)
    const id = f.conversation.id
    try {
      const denied = await f.call('agent_chat_send', { request: { requestId: randomUUID(), content: 'Denied',
        intent: 'next_turn', expectedConversationId: id, context: f.context } }, f.reader.token)
      expect(denied.error || denied.result?.isError).toBeTruthy()
      expect(f.provider.prompts).toHaveLength(0)
      const first = await f.send('Read the task and reply')
      expect(first.events.some(event => event.type === 'delta')).toBe(true)
      const read = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
      expect(read.messages.some(message => message.role === 'assistant'
        && message.content === 'Remote streamed answer')).toBe(true)
      expect(read.conversation?.harness).toBe(harness)
      expect(f.frames.some(frame => frame.method === 'conversation.history' && frame.waitForEvents)).toBe(true)
      const controls = () => f.value('agent_chat_controls_get', { conversationId: id })
        .then(value => SessionControlStateSchema.parse(value))
      const initial = await controls()
      expect(initial.capabilities.plan.supported).toBe(true)
      expect(initial.capabilities.compact.supported).toBe(true)
      const mode = async (mode: 'plan' | 'regular') => {
        const before = await controls()
        return SessionControlStateSchema.parse(await f.value('agent_chat_controls_update', { conversationId: id,
          request: { kind: 'mode', mode, requestId: randomUUID(), expectedRevision: before.revision } }))
      }
      expect((await mode('plan')).desiredMode).toBe('plan')
      await f.send('Plan the next task')
      expect(f.provider.modes.at(-1)).toBe('plan')
      expect((await controls()).appliedMode).toBe('plan')
      expect((await mode('regular')).desiredMode).toBe('regular')
      await f.send('Continue in regular mode')
      expect(f.provider.modes.at(-1)).toBe('default')
      expect((await controls()).appliedMode).toBe('regular')
      const beforeCompact = await controls()
      const compact = SessionControlStateSchema.parse(await f.value('agent_chat_controls_update', {
        conversationId: id, request: { kind: 'compact', requestId: randomUUID(),
          expectedRevision: beforeCompact.revision },
      }))
      expect(['accepted', 'running', 'completed']).toContain(compact.compaction?.status)
      await vi.waitFor(async () => expect((await controls()).compaction?.status).toBe('completed'))
      expect(f.provider.compactions).toBe(1)
      expect(f.frames.filter(frame => frame.method === 'conversation.compact')).toHaveLength(1)
      const beforeNew = f.provider.prompts.length
      const rejectedNew = await f.call('agent_chat_send', { request: { requestId: randomUUID(), content: '/new',
        intent: 'next_turn', expectedConversationId: id, context: f.context } })
      expect(rejectedNew.error || rejectedNew.result?.isError).toBeTruthy()
      expect(JSON.stringify(rejectedNew)).toContain('SESSION_COMMAND_ROUTE_REQUIRED')
      expect(f.provider.prompts).toHaveLength(beforeNew)
      expect((await f.repository.get(id))?.native_session_id).toBe(read.conversation?.nativeSession?.nativeSessionId)
    } finally { await f.close() }
  }, 120_000)

it.each(['codex', 'claude'] as const)(
  'persists a remote %s Agent model change but rejects its next turn at the old Worker binding', async harness => {
    const f = await remoteAgentConversation(harness)
    try {
      await f.send('Establish the remote session')
      const original = (await f.repository.get(f.conversation.id))!
      const originalBinding = await f.binding()
      const before = f.provider.prompts.length
      const changed = { ...f.configuration.harness, model: 'changed-model' }
      const denied = await f.call('agent_update', { agentId: f.context.agentId,
        commandId: randomUUID(), configuration: changed, expectedRevision: 1,
        expectedConfigurationVersionId: f.configuration.id }, f.reader.token)
      expect(denied.error || denied.result?.isError).toBeTruthy()
      const update = AgentMutationResultSchema.parse(await f.update(changed))
      expect(update.value.agent.harnessConfiguration?.model).toBe('changed-model')
      const failed = await f.send('Use the saved model on this turn', 'failed')
      expect(failed.turn?.error).toMatchObject({ code: 'WORKER_CONVERSATION_UNAVAILABLE' })
      expect(failed.turn?.error?.message).toBe('The original worker conversation binding changed.')
      expect(f.provider.prompts).toHaveLength(before)
      const saved = (await f.repository.get(f.conversation.id))!
      expect(saved.agent_configuration_version_id).toBe(update.value.agent.configurationVersionId)
      expect(await f.binding()).toEqual(originalBinding)
      expect(saved.native_session_id).toBe(original.native_session_id)
    } finally { await f.close() }
  }, 120_000)

it.each(['codex', 'claude'] as const)(
  'rejects a remote %s Agent harness change at the retained Worker binding after saving it', async harness => {
    const f = await remoteAgentConversation(harness)
    try {
      await f.send('Establish the remote session')
      const original = (await f.repository.get(f.conversation.id))!
      const originalBinding = await f.binding()
      const changed = DEFAULT_HARNESS_DEFAULTS[harness === 'codex' ? 'claude' : 'codex']!
      const update = AgentMutationResultSchema.parse(await f.update(changed))
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
  }, 120_000)

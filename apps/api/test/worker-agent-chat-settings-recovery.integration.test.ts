import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { AgentChatStateSchema } from '@foreman-code/contracts/agent-chat'
import { AgentMutationResultSchema } from '@foreman-code/contracts/management'
import { remoteAgentConversation } from './helpers/remoteAgentConversation.js'
import { workerConversationFixture } from '../src/modules/conversations/workerFixtures.test-support.js'

it.each((['codex', 'claude'] as const).flatMap(harness =>
  (['account', 'harness'] as const).map(setting => ({ harness, setting }))))(
  'replaces the retained $harness session for a $setting edit after Main restarts', async ({ harness, setting }) => {
    const f = await remoteAgentConversation(harness)
    try {
      const first = await f.send('Remember the original conversation')
      const original = (await f.repository.get(f.conversation.id))!
      const originalBinding = await f.binding()
      const firstTurn = await f.repository.turn(f.conversation.id, first.requestId)
      await f.restartMain()
      expect(await f.journal.conversations.read(originalBinding)).toMatchObject({
        closed: false, runtimeReleased: true, session: { nativeSessionId: original.native_session_id },
      })
      const denied = await f.call('agent_chat_send', { request: {
        requestId: randomUUID(), content: 'A reader cannot replace the session', intent: 'next_turn',
        expectedConversationId: f.conversation.id, context: f.context,
      } }, f.reader.token)
      expect(denied.result?.isError || denied.error).toBeTruthy()
      expect(await f.binding()).toEqual(originalBinding)

      const configuration = setting === 'account'
        ? { ...f.configuration.harness, accountId: randomUUID() }
        : workerConversationFixture('agent', harness === 'codex' ? 'claude' : 'codex').configuration.harness
      const saved = AgentMutationResultSchema.parse(await f.update(configuration, { matchingProfile: true }))
      const sent = await f.send('Continue using the saved settings')
      expect(sent.turn?.delivery).toBe('completed')
      expect(await f.repository.turn(f.conversation.id, first.requestId)).toEqual(firstTurn)
      expect(await f.journal.conversations.read(originalBinding)).toMatchObject({
        closed: true, session: { nativeSessionId: original.native_session_id },
      })
      const replacement = await f.binding()
      expect(replacement.sessionGeneration).toBe(saved.value.agent.configurationVersionId)
      expect(replacement.owner.configurationVersionId).toBe(saved.value.agent.configurationVersionId)
      const read = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
      expect(read.conversation?.nativeSession?.nativeSessionId).toBeTruthy()
      expect(read.conversation?.nativeSession?.nativeSessionId).not.toBe(original.native_session_id)
      expect(read.conversation?.agentConfigurationVersionId).toBe(saved.value.agent.configurationVersionId)
      expect(f.providers.reduce((count, provider) => count + provider.prompts.length, 0)).toBe(2)
    } finally { await f.close() }
  }, 30_000)

it.each(['resident', 'recovered'] as const)(
  'retires a %s Worker turn as its sender after a read-only observer reads it', async mode => {
    const f = await remoteAgentConversation('codex')
    const requestId = randomUUID()
    const terminal: string[] = []
    let unsubscribe = () => {}
    try {
      await f.send('Establish the saved session')
      if (mode === 'recovered') await f.restartMain()
      const originalSession = (await f.repository.get(f.conversation.id))!.native_session_id
      unsubscribe = f.chat.events.subscribe(f.conversation.id, event => {
        if (event.data.requestId === requestId && event.data.delivery === 'completed') terminal.push(requestId)
      })
      f.provider.holdReply()
      await f.value('agent_chat_send', { request: { requestId, content: 'Finish while a reader is observing',
        intent: 'next_turn', expectedConversationId: f.conversation.id, context: f.context } })
      await vi.waitFor(() => expect(f.provider.prompts).toHaveLength(2))
      const observed = await f.call('agent_chat_read', { query: f.context }, f.reader.token)
      expect(observed.result?.isError, JSON.stringify(observed)).not.toBe(true)
      const denied = await f.call('agent_chat_send', { request: {
        requestId: randomUUID(), content: 'Denied reader input', intent: 'next_turn',
        expectedConversationId: f.conversation.id, context: f.context,
      } }, f.reader.token)
      expect(denied.result?.isError || denied.error).toBeTruthy()
      f.provider.releaseReply()
      await vi.waitFor(async () => {
        expect((await f.repository.turn(f.conversation.id, requestId))?.delivery).toBe('completed')
        expect(terminal).toEqual([requestId])
      })
      await f.drainWorker()
      expect(f.frames).toContainEqual(expect.objectContaining({ method: 'conversation.retire-turn',
        correlationId: `agent-chat:${f.conversation.id}:${requestId}` }))
      const read = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
      expect(read.conversation?.nativeSession?.nativeSessionId).toBe(originalSession)
      expect(read.activeTurn).toBeNull()
      expect(f.provider.prompts).toHaveLength(2)
    } finally {
      f.provider.releaseReply()
      unsubscribe()
      await f.value('agent_chat_read', { query: f.context })
      await f.close()
    }
  }, 30_000)

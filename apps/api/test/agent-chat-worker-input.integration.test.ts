import { createHash, randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { AgentChatStateSchema, SendAgentChatMessageResponseSchema } from '@foreman-code/contracts/agent-chat'
import { remoteAgentConversation } from './helpers/remoteAgentConversation.js'
import { graphHeaders } from './eng04-graph-composition-fixture.js'

it.each(['main', 'worker'] as const)('steers an active Codex turn on %s through authenticated MCP', async location => {
  const f = await remoteAgentConversation('codex', location)
  f.provider.holdReply()
  const sending = f.send('Keep working until released')
  try {
    let before = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
    await vi.waitFor(async () => {
      before = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
      expect(before.activeTurn?.nativeTurnId).toBeTruthy()
    }, { timeout: 5000 })
    const request = { requestId: randomUUID(), content: 'Use the second approach', intent: 'steer',
      expectedConversationId: f.conversation.id, expectedNativeTurnId: before.activeTurn!.nativeTurnId,
      context: f.context }
    const denied = await f.call('agent_chat_send', { request }, f.reader.token)
    expect(denied.error || denied.result?.isError).toBeTruthy()
    const stale = await f.call('agent_chat_send', { request: { ...request, expectedNativeTurnId: 'finished-turn' } })
    expect(stale.error || stale.result?.isError).toBeTruthy()
    expect(f.provider.calls.filter(method => method === 'turn/steer')).toHaveLength(0)
    const sent = SendAgentChatMessageResponseSchema.parse(await f.value('agent_chat_send', { request }))
    expect(sent.turn).toMatchObject({ requestId: request.requestId, intent: 'steer', delivery: 'accepted',
      targetNativeTurnId: before.activeTurn!.nativeTurnId })
    expect(sent.state.activeTurn).toEqual(before.activeTurn)
    expect(f.provider.calls.filter(method => method === 'turn/steer')).toHaveLength(1)
    expect(sent.state.messages.some(message => message.requestId === request.requestId
      && message.content === request.content)).toBe(true)
    const replay = SendAgentChatMessageResponseSchema.parse(await f.value('agent_chat_send', { request }))
    expect(replay.replayed).toBe(true)
    expect(f.provider.calls.filter(method => method === 'turn/steer')).toHaveLength(1)
  } finally {
    f.provider.releaseReply()
    await sending
    await f.close()
  }
}, 30_000)

it.each((['codex', 'claude'] as const).flatMap(harness => [false, true].map(existing => ({ harness, existing }))))(
  'delivers attachment-only messages to Worker $harness through MCP (existing session: $existing)', async ({ harness, existing }) => {
  const f = await remoteAgentConversation(harness)
  try {
    if (existing) await f.send('Establish the session')
    const text = 'The attachment is the complete follow-up request.'
    const attachment = await f.upload(Buffer.from(text))
    const requestId = randomUUID()
    await f.value('agent_chat_send', { request: { requestId, content: '', intent: 'next_turn',
      expectedConversationId: f.conversation.id, context: f.context, attachments: [attachment] } })
    await vi.waitFor(async () => {
      const state = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
      expect(state.turns.find(turn => turn.requestId === requestId)?.delivery).toBe('completed')
    }, { timeout: 5000 })
    expect(f.receivedAttachments).toEqual([text])
    const read = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
    expect(read.messages.find(message => message.requestId === requestId && message.role === 'user'))
      .toMatchObject({ content: '', originalInput: { requestId, content: '', attachments: [attachment] },
        attachments: [{
          file: { fileId: attachment.fileId, state: 'ready' },
          revision: { ...attachment, filename: 'attached.md', mediaType: 'text/markdown',
            byteSize: Buffer.byteLength(text), sha256: createHash('sha256').update(text).digest('hex') },
        }] })
    expect(read.turns.find(turn => turn.requestId === requestId)?.delivery).toBe('completed')
  } finally { await f.close() }
}, 30_000)

it('delivers an admitted large Worker message within the complete serialized RPC limit', async () => {
  const f = await remoteAgentConversation('codex')
  try {
    await f.send('Establish the session')
    const content = 'Large pasted log line\n'.repeat(20_000).trim()
    const sent = await f.send(content)
    expect(sent.turn?.delivery).toBe('completed')
    const input = f.frames.find(frame => frame.method === 'conversation.start-turn' && frame.prompt === content)
    expect(input).toMatchObject({ method: 'conversation.start-turn', prompt: content })
    for (const frame of f.frames) expect(Buffer.byteLength(JSON.stringify(frame))).toBeLessThanOrEqual(1024 * 1024)
    expect(await f.repository.turnContent(f.conversation.id, sent.requestId)).toBe(content)
  } finally { await f.close() }
}, 30_000)

it.each([
  ['ASCII characters', 'x'.repeat(1_000_001)],
  ['multibyte text', '界'.repeat(350_000)],
  ['JSON escapes', '\u0001'.repeat(200_000)],
] as const)('rejects oversized %s through HTTP and MCP before a Worker message is saved', async (_name, content) => {
  const f = await remoteAgentConversation('codex')
  try {
    const before = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
    for (const source of ['http', 'mcp'] as const) {
      const request = { requestId: randomUUID(), content, intent: 'next_turn',
        expectedConversationId: f.conversation.id, context: f.context }
      if (source === 'http') {
        const { workspaceId: _workspaceId, ...context } = f.context
        const response = await f.app.inject({ method: 'POST',
          url: `/api/workspaces/${f.context.workspaceId}/agent-chat/messages`,
          headers: graphHeaders(f.writer.token), payload: { ...request, context } })
        expect(response.statusCode).toBe(400)
        expect(response.body).toMatch(/768 KiB|1000000|1,000,000/)
      } else {
        const response = await f.call('agent_chat_send', { request })
        expect(response.error || response.result?.isError).toBeTruthy()
        expect(JSON.stringify(response)).toMatch(/768 KiB|1000000|1,000,000/)
      }
      const after = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
      expect(after.messages).toEqual(before.messages)
      expect(after.turns).toEqual(before.turns)
      expect(after.activeTurn).toBeNull()
    }
    expect(f.provider.prompts).toHaveLength(0)
    expect(f.frames.some(frame => ['conversation.start-turn', 'conversation.initial-turn'].includes(frame.method))).toBe(false)
  } finally { await f.close() }
}, 30_000)

it('rejects individually valid message and System prompt sizes whose Worker envelope exceeds one MiB', async () => {
  const f = await remoteAgentConversation('codex')
  try {
    // Both inputs fit their individual public contracts; their actual binding+prompt does not.
    await f.db.pool.query(`update operator_conversations set record=record || $2::jsonb where id=$1`,
      [f.conversation.id, JSON.stringify({ systemPrompt: {
        value: { text: '界'.repeat(100_000) }, revision: 1, versionId: 'saved-system-prompt',
      } })])
    const before = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
    const response = await f.call('agent_chat_send', { request: { requestId: randomUUID(), content: 'x'.repeat(750 * 1024),
      intent: 'next_turn', expectedConversationId: f.conversation.id, context: f.context } })
    expect(response.error || response.result?.isError).toBeTruthy()
    expect(JSON.stringify(response)).toContain('CHAT_MESSAGE_TOO_LARGE')
    const after = AgentChatStateSchema.parse(await f.value('agent_chat_read', { query: f.context }))
    expect(after.messages).toEqual(before.messages)
    expect(after.turns).toEqual(before.turns)
    expect(f.provider.prompts).toHaveLength(0)
  } finally { await f.close() }
}, 30_000)

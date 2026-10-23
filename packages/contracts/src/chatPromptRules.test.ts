import { describe, expect, it } from 'vitest'
import { SendOperatorMessageRequestSchema } from './index.js'
import { SendAgentChatMessageRequestSchema } from './agentChat.js'
import { ChatSendRequestSchema } from './chatDelivery.js'
import { CHAT_MAX_MESSAGE_JSON_BYTES } from './chatInput.js'
import { agentChatFixtures } from './agentChatFixtures.js'

const { workspaceId, ...agent } = agentChatFixtures.empty.context
const file = { fileId: 'file', revisionId: 'revision' }
const sendRequests = {
  agent: (fields: object) => SendAgentChatMessageRequestSchema.safeParse(
    { requestId: 'request', expectedConversationId: null, context: agent, content: 'hello', ...fields }),
  operator: (fields: object) => SendOperatorMessageRequestSchema.safeParse({ requestId: 'request', content: 'hello', ...fields }),
  canonical: (fields: object) => ChatSendRequestSchema.safeParse({ commandId: 'command', intent: 'next_turn', content: 'hello',
    target: { kind: 'agent_conversation', agent: agentChatFixtures.empty.context, conversationId: 'conversation' }, ...fields }),
}
const messages = (result: { success: boolean; error?: { issues: { path: PropertyKey[]; message: string }[] } }) =>
  result.error?.issues.map(issue => `${issue.path.join('.')}: ${issue.message}`) ?? []

describe.each(Object.entries(sendRequests))('%s send prompt rules', (_name, send) => {
  it('requires text or an attachment', () => {
    expect(messages(send({ content: '   ' }))).toContain('content: Message requires text or an attachment.')
    expect(send({ content: '', attachments: [file] }).success).toBe(true)
  })

  it('rejects attachments on steer and accepts them for a new turn', () => {
    expect(messages(send({ intent: 'steer', attachments: [file] })))
      .toContain('attachments: Attachment steering is not supported. Send attachments in a new turn.')
    expect(send({ intent: 'steer' }).success).toBe(true)
    expect(send({ intent: 'next_turn', attachments: [file] }).success).toBe(true)
  })
})

describe.each(['agent', 'operator'] as const)('%s message size', name => {
  const oversized = 'x'.repeat(CHAT_MAX_MESSAGE_JSON_BYTES)
  it('rejects content over the shared size limit', () => {
    const result = sendRequests[name]({ content: oversized })
    expect(result.success).toBe(false)
    expect(messages(result)).toContain(
      'content: Message and metadata must fit within 768 KiB of UTF-8 JSON. Shorten the message or send the content as an attachment.')
  })
})

describe('Operator receipt recovery', () => {
  it('skips only the size check', () => {
    const oversized = 'x'.repeat(CHAT_MAX_MESSAGE_JSON_BYTES)
    expect(sendRequests.operator({ content: oversized, recovery: 'receipt' }).success).toBe(true)
    expect(sendRequests.operator({ content: '', recovery: 'receipt' }).success).toBe(false)
    expect(sendRequests.operator({ intent: 'steer', attachments: [file], recovery: 'receipt' }).success).toBe(false)
  })
})

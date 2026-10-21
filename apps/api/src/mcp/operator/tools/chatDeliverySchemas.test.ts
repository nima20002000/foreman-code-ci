import { expect, it } from 'vitest'

it('constructs discoverable chat tools while retaining canonical input validation', async () => {
  const { createAgentChatTools } = await import('./agentChat.js')
  const { createOperatorControlTools, createOperatorDeliveryTools } = await import('./operatorControls.js')
  const tools = [...createAgentChatTools(), ...createOperatorControlTools(), ...createOperatorDeliveryTools()]
  const send = tools.find(tool => tool.name === 'agent_chat_send')!
  const request = { workspaceId: 'workspace', commandId: 'command', content: 'Continue', intent: 'steer',
    target: { kind: 'agent_conversation', conversationId: 'conversation',
      agent: { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'node', agentId: 'agent' } } }
  expect(send.inputSchema.safeParse(request).success).toBe(true)
  expect(send.inputSchema.safeParse({ ...request, attachments: [{ fileId: 'file', revisionId: 'revision' }] }).success).toBe(false)
  expect(tools.map(tool => tool.name)).toEqual(expect.arrayContaining([
    'agent_chat_ensure_conversation', 'agent_chat_cancel_all_queued', 'operator_chat_cancel_queued', 'operator_chat_cancel_all_queued',
  ]))
})

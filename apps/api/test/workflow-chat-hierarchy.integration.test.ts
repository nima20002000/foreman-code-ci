import { expect, it } from 'vitest'
import { ChatDeliveryReceiptSchema, EngineChatReadbackSchema } from '@foreman-code/contracts'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { workflowChatCall, workflowChatTarget } from './helpers/workflowChatRequests.js'

it('asks the waiting coordinator through authenticated per-Agent MCP without changing its delegated work', async () => {
  const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
    node === 'master' ? { select: ['build'] } : {}))
  const f = await currentOperatorIntegration({ executionChat: true, fixture: hierarchyRuntimeFixture(),
    approvalNodeIds: [], collaborationPorts: {}, managerFactory: context => provider.connection(context) })
  const drive = f.engine.start(f.f.run.id).catch(error => error)
  try {
    await provider.entered('builder')
    const target = await workflowChatTarget(f, 'master')
    expect(target.kind).toBe('workflow_coordinator')
    const before = (await f.runs.listRepeatExecutions(f.f.run.id)).map(row => row.execution)
    const request = { commandId: 'master-question', target, intent: 'next_turn', content: 'Explain current progress' }
    const receipt = ChatDeliveryReceiptSchema.parse(await workflowChatCall(f, 'agent_chat_send', request))
    await expect.poll(() => provider.consultations.length, { timeout: 15_000 }).toBe(1)
    expect((await f.runs.listRepeatExecutions(f.f.run.id)).map(row => row.execution)).toEqual(before)
    const replay = ChatDeliveryReceiptSchema.parse(await workflowChatCall(f, 'agent_chat_send', request))
    expect(replay.id).toBe(receipt.id)
    expect(provider.consultations).toHaveLength(1)
    await expect.poll(async () => EngineChatReadbackSchema.parse(await workflowChatCall(f, 'agent_chat_read', { target })),
      { timeout: 15_000 }).toMatchObject({ messages: expect.arrayContaining([expect.objectContaining({
        content: 'The delegated work is still in progress.',
      })]) })
    provider.release('builder')
    expect(await drive).not.toBeInstanceOf(Error)
  } finally { provider.releaseAll(); await f.stop(); await drive; await f.close() }
}, 60_000)

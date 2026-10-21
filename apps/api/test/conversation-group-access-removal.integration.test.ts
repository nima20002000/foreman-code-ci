import { afterEach, expect, it } from 'vitest'
import { ReadAgentChatResponseSchema } from '@foreman-code/contracts/agent-chat'
import { CurrentWorkflowReadResultSchema } from '@foreman-code/contracts/wave25'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { closeActivityReplay, eventually, setup } from './helpers/activityReplayFixture.js'

afterEach(closeActivityReplay)

it('continues the same native conversation after removing its previously bound Group tools', async () => {
  const f = await setup({ chatTools: true })
  const { workspaceId, workflowId } = f.saved.scope
  const node = f.saved.version.definition.nodes[0]!
  const query = { workflowId, workflowNodeId: node.id, agentId: node.agentId }
  const read = async () => {
    const response = await f.call('agent_chat_read', { workspaceId, query })
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    return ReadAgentChatResponseSchema.parse(decodeMcpToolResult(response))
  }
  const send = async (requestId: string, expectedConversationId: string | null) => {
    f.replay.nextStart = 'complete'
    const response = await f.call('agent_chat_send', { workspaceId, request: {
      context: query, requestId, expectedConversationId, intent: 'next_turn', content: requestId,
    } })
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    const state = await eventually(read, value => value.turns.some(turn => turn.requestId === requestId
      && ['completed', 'failed', 'canceled'].includes(turn.delivery)))
    expect(state.turns.find(turn => turn.requestId === requestId)).toMatchObject({ delivery: 'completed' })
    return state
  }
  const first = await send('with-group-access', null)
  const conversation = first.conversation!
  const native = conversation.nativeSession!.nativeSessionId
  const token = f.replay.appTokens.get(native)!
  expect(token).toBeTruthy()
  const groupUrl = `/api/workspaces/${workspaceId}/workflows/${workflowId}/chat`
  expect((await f.http('GET', groupUrl, undefined, token)).statusCode).toBe(200)
  const credentials = () => f.db.pool.query('select principal_id from agent_conversation_credentials where conversation_id=$1', [conversation.id])
  const issued = (await credentials()).rows
  const saved = CurrentWorkflowReadResultSchema.parse(decodeMcpToolResult(
    await f.call('workflow_saved_get_v3', { workspaceId, workflowId })))
  const update = await f.call('workflow_save_v3', { workspaceId, workflowId, executionSemanticsVersion: 3,
    expectedRevision: saved.revision, expectedWorkflowVersionId: saved.currentVersionId,
    expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
    graph: { ...saved.version.definition, nodes: saved.version.definition.nodes.map(value => value.id === node.id
      ? { ...value, graphqlTools: { add: [], remove: ['workflow_chat_read', 'workflow_chat_post'] } } : value) },
  })
  expect(update.isError, JSON.stringify(update)).not.toBe(true)
  const second = await send('after-group-removal', conversation.id)
  expect(second.conversation).toMatchObject({ id: conversation.id, nativeSession: { nativeSessionId: native } })
  expect(f.replay.starts.filter(start => start.sessionId === native)).toHaveLength(2)
  expect([401, 403]).toContain((await f.http('GET', groupUrl, undefined, token)).statusCode)
  expect((await credentials()).rows).toEqual(issued)
  expect(second.turns.find(turn => turn.requestId === 'with-group-access')).toMatchObject({ delivery: 'completed' })
}, 60_000)

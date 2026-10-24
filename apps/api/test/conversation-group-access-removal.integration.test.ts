import { afterEach, expect, it } from 'vitest'
import { ReadAgentChatResponseSchema } from '@foreman-code/contracts/agent-chat'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { closeActivityReplay, eventually, setup } from './helpers/activityReplayFixture.js'

afterEach(closeActivityReplay)

it.each(['resident', 'cold'] as const)('continues a %s Agent conversation with no Group chat routes or MCP tools', async mode => {
  const f = await setup()
  const { workspaceId, workflowId } = f.saved.scope
  const node = f.saved.version.definition.nodes[0]!
  const query = { workflowId, workflowNodeId: node.id, agentId: node.agentId }
  const read = async () => {
    const response = await f.call('agent_chat_read', { workspaceId, query })
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    return ReadAgentChatResponseSchema.parse(decodeMcpToolResult(response))
  }
  const send = async (requestId: string, expectedConversationId: string | null) => {
    f.replay.nextStart = 'active'
    const response = await f.call('agent_chat_send', { workspaceId, request: {
      context: query, requestId, expectedConversationId, intent: 'next_turn', content: requestId,
    } })
    expect(response.isError, JSON.stringify(response)).not.toBe(true)
    const started = await eventually(read, value => value.activeTurn?.requestId === requestId && !!value.activeTurn.nativeTurnId
      || value.turns.some(turn => turn.requestId === requestId && ['failed', 'canceled'].includes(turn.delivery)))
    if (started.activeTurn?.requestId === requestId && started.activeTurn.nativeTurnId) {
      f.replay.complete(started.conversation!.nativeSession!.nativeSessionId, started.activeTurn.nativeTurnId,
        `Answer to ${requestId}`, `answer-${requestId}`)
    }
    const state = await eventually(read, value => value.turns.some(turn => turn.requestId === requestId
      && ['completed', 'failed', 'canceled'].includes(turn.delivery))).catch(async cause => {
      const latest = await read()
      throw new Error(JSON.stringify({ turns: latest.turns, availability: latest.availability,
        starts: f.replay.starts, calls: f.replay.calls.slice(-12), closes: f.replay.closes }), { cause })
    })
    expect(state.turns.find(turn => turn.requestId === requestId)).toMatchObject({ delivery: 'completed' })
    return state
  }
  const first = await send('first-input', null)
  const conversation = first.conversation!
  const native = conversation.nativeSession!.nativeSessionId
  for (const name of ['workflow_chat_read', 'workflow_chat_post', 'workflow_chat_deliveries_read', 'workflow_chat_delivery_cancel']) {
    const removed = await f.call(name, { workspaceId, workflowId })
    expect(removed.isError, JSON.stringify(removed)).toBe(true)
  }
  for (const [method, suffix] of [['GET', ''], ['POST', '/posts'], ['GET', '/deliveries'], ['GET', '/events'], ['POST', '/deliveries/missing/cancel']] as const) {
    const removed = await f.http(method, `/api/workspaces/${workspaceId}/workflows/${workflowId}/chat${suffix}`)
    expect(removed.statusCode, removed.body).toBe(404)
  }
  if (mode === 'cold') await f.restart()
  const second = await send('second-input', conversation.id)
  expect(second.conversation).toMatchObject({ id: conversation.id, nativeSession: { nativeSessionId: native } })
  expect(f.replay.starts.filter(start => start.sessionId === native)).toHaveLength(2)
  expect(second.turns.find(turn => turn.requestId === 'first-input')).toMatchObject({ delivery: 'completed' })
}, 60_000)

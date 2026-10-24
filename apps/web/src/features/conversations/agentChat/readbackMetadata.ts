import type { DeliveryTarget } from '@foreman-code/contracts'
import type { AgentChatState } from '@foreman-code/contracts/agent-chat'
import { replaceEqualDeep } from '@tanstack/react-query'
import type { agentChatApi } from '../../../shared/api/agentChat'
import { acceptAgentChatState, inheritCommittedRevision } from '../../chat-core'

type AgentReadback = Awaited<ReturnType<typeof agentChatApi.read>>

export function deliveryTargetMatches(state: AgentChatState, target: DeliveryTarget | undefined) {
  if (!target) return true
  if (target.kind === 'operator_conversation') return false
  const context = state.context, agent = target.agent
  if (agent.workspaceId !== context.workspaceId || agent.workflowId !== context.workflowId
    || agent.workflowNodeId !== context.workflowNodeId || agent.agentId !== context.agentId) return false
  if (target.kind === 'agent_conversation') return !state.conversation || target.conversationId === state.conversation.id
  return target.kind === 'workflow_execution' ? target.execution.runId === context.runId : target.runId === context.runId
}

/** Native snapshots contain the inner state only. Fresh authorized GETs own the outer target metadata. */
export function acceptAgentReadback(previous: AgentReadback | undefined, incoming: AgentReadback,
  source: 'read' | 'receipt' = 'receipt'): AgentReadback {
  const accepted = acceptAgentChatState(previous, incoming, source)
  const fresh = source === 'read' && incoming.revision >= accepted.revision
    && incoming.conversation?.id === accepted.conversation?.id
  const metadata = fresh ? incoming : previous
  const target = deliveryTargetMatches(accepted, metadata?.deliveryTarget) ? metadata?.deliveryTarget : undefined
  const sameConversation = metadata?.conversation?.id === accepted.conversation?.id
  const result: AgentReadback = { ...accepted,
    history: sameConversation ? metadata?.history : undefined,
    receipts: sameConversation ? metadata?.receipts : undefined,
    executionActivity: sameConversation ? metadata?.executionActivity : undefined,
    deliveryTarget: target,
    deliveryTargetState: target?.kind === 'agent_conversation' && accepted.conversation?.id === target.conversationId
      ? 'existing' : target ? metadata?.deliveryTargetState : undefined,
    deliveryInputs: target && sameConversation ? metadata?.deliveryInputs : undefined,
  }
  const shared = replaceEqualDeep(previous, result)
  const messages = new Map(previous?.messages.map(message => [message.id, message]))
  // Match messages by ID rather than array offset when history windows advance.
  return { ...shared, messages: result.messages.map(message =>
    inheritCommittedRevision(replaceEqualDeep(messages.get(message.id), message), message)) }
}

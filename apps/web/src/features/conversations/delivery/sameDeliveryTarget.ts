import type { DeliveryTarget } from '@foreman-code/contracts'

export function sameDeliveryTarget(a: DeliveryTarget, b: DeliveryTarget): boolean {
  if (a.kind !== b.kind) return false
  if (a.kind === 'operator_conversation') {
    return b.kind === 'operator_conversation' && a.conversationId === b.conversationId
  }
  if (b.kind === 'operator_conversation') return false
  if (a.agent.workspaceId !== b.agent.workspaceId || a.agent.workflowId !== b.agent.workflowId
    || a.agent.workflowNodeId !== b.agent.workflowNodeId || a.agent.agentId !== b.agent.agentId) return false
  if (a.kind === 'agent_conversation' && b.kind === a.kind) return a.conversationId === b.conversationId
  if (a.kind === 'workflow_coordinator' && b.kind === a.kind) return a.runId === b.runId && a.waitingActivationId === b.waitingActivationId
  return a.kind === 'workflow_execution' && b.kind === a.kind
    && a.execution.runId === b.execution.runId && a.execution.workflowVersionId === b.execution.workflowVersionId
    && a.execution.executionId === b.execution.executionId && a.execution.attempt === b.execution.attempt
    && a.execution.activationId === b.execution.activationId
}

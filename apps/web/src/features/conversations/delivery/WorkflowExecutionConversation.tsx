import { AgentConversation } from '../agentChat/AgentConversation'
import type { WorkflowExecutionChatViewProps } from '../../workflow-hierarchy/execution-chat/types'
import { ExecutionChatPanel } from './ExecutionChatPanel'
import { productionExecutionChatSource } from './productionExecutionChatSource'

export function WorkflowExecutionConversation(props: WorkflowExecutionChatViewProps) {
  return <SelectedConversation key={JSON.stringify(props.resolved.target)} {...props} />
}

function SelectedConversation({ resolved, onSelectTarget }: WorkflowExecutionChatViewProps) {
  const target = resolved.target
  // A finished execution continues in its Agent chat right here, so the owner can always message the Agent.
  const followUp = target.kind === 'workflow_execution' ? <AgentConversation
    context={{ ...target.agent, runId: target.execution.runId }} name={resolved.agent.displayName}
    selection={{ workspaceId: target.agent.workspaceId, workflowId: target.agent.workflowId,
      workflowNodeId: target.agent.workflowNodeId, runId: target.execution.runId, executionId: target.execution.executionId }} /> : undefined
  return <ExecutionChatPanel visible target={target} name={resolved.agent.displayName} source={productionExecutionChatSource}
    followUp={followUp} onOpenContinuation={receipt => {
      if (receipt.continuationExecution) onSelectTarget({ kind: 'workflow_execution', agent: target.agent,
        execution: receipt.continuationExecution }, receipt.continuationExecution.workflowVersionId)
    }} />
}

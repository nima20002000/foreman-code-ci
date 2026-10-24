import { useState, type ReactNode } from 'react'
import { Paperclip } from 'lucide-react'
import { Button, IconButton, Tooltip } from '../../../shared/ui/nocturne'
import { LiveAgentConversation } from '../agentChat/LiveAgentConversation'
import { AgentConversation } from '../agentChat/AgentConversation'
import type { WorkflowExecutionChatViewProps } from '../../workflow-hierarchy'
import { ExecutionChatPanel } from './ExecutionChatPanel'
import { productionExecutionChatSource } from './productionExecutionChatSource'

export function WorkflowExecutionConversation(props: WorkflowExecutionChatViewProps) {
  return <SelectedConversation key={JSON.stringify(props.resolved.target)} {...props} />
}

function SelectedConversation({ resolved }: WorkflowExecutionChatViewProps) {
  const target = resolved.target
  const [separate, setSeparate] = useState(false)
  if (separate) return <><p className="workflow-panel-hint">Separate chat outside this Run</p>
    <Button size="sm" onClick={() => setSeparate(false)}>Back to Run chat</Button>
    <LiveAgentConversation context={target.agent} name={resolved.agent.displayName} /></>
  // A finished execution continues in its Agent chat right here, so the owner can always message the Agent.
  const followUp = target.kind === 'workflow_execution' ? (retainedInputs: ReactNode) => <AgentConversation retainedInputs={retainedInputs}
    context={{ ...target.agent, runId: target.execution.runId }} name={resolved.agent.displayName}
    onNewConversation={() => setSeparate(true)}
    selection={{ workspaceId: target.agent.workspaceId, workflowId: target.agent.workflowId,
      workflowNodeId: target.agent.workflowNodeId, runId: target.execution.runId, executionId: target.execution.executionId }} /> : undefined
  return <ExecutionChatPanel visible target={target} name={resolved.agent.displayName} source={productionExecutionChatSource}
    attachmentControl={<div className="attachment-control"><Tooltip content={target.kind === 'workflow_execution'
      ? 'Files can be attached after this execution finishes.' : 'Files can be attached in a separate Agent conversation.'}>
      <IconButton label="Attach files" size="sm" variant="ghost" disabled><Paperclip size={18} aria-hidden="true" /></IconButton>
    </Tooltip></div>}
    followUp={followUp} />
}

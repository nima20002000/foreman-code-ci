import { BrowserProfileManager, ComputerBrowserProfiles, NodeBrowserFields, BrowserSetupHost } from './BrowserProfileFeatures'
import { WorkflowBrowser } from './WorkflowBrowser'
import { returnBrowserControl } from './browserRecovery'
import { BrowserRecovery } from './BrowserRecovery'
import type { ReactNode } from 'react'
import { EngineChatMessageSchema, WorkflowExecutionChatMessageRequestSchema } from '@foreman-code/contracts'
import { CollaborationUIProvider, type CollaborationUISlots } from '../shared/ui/collaborationSlots'
import { apiClient, ApiError } from '../shared/api/client'
import { ExecutionChatPanel } from '../features/conversations/delivery/ExecutionChatPanel'
import type { ExecutionChatSource } from '../features/conversations/delivery/executionChatSource'
import { LiveAgentConversation } from '../features/conversations/agentChat/LiveAgentConversation'
import { subscribeHierarchy } from '../features/workflow-hierarchy/stream'
import type { WorkflowExecutionChatViewProps, WorkflowOutsideRunChatViewProps } from '../features/workflow-hierarchy/execution-chat/types'

const executionSource: ExecutionChatSource = {
  subscribe(target, receive, options) {
    let revision = 0
    const close = subscribeHierarchy({ ...target.agent,
      runId: target.kind === 'workflow_execution' ? target.execution.runId : target.runId }, {
      changed: () => receive({ target, revision: ++revision, snapshotRequired: true }),
      connection: connected => { if (connected) options.reconnect() },
      unavailable: () => options.error(new ApiError({ code: 'ACCESS_DENIED', message: 'This Run chat is unavailable.' }, 403)),
    })
    options.signal.addEventListener('abort', close, { once: true })
    return () => { options.signal.removeEventListener('abort', close); close() }
  },
  readMessage(target, message, options) {
    const { workspaceId, workflowId } = target.agent
    return apiClient.request(`/api/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/execution-chat/message`,
      EngineChatMessageSchema, { ...options, method: 'POST', body: WorkflowExecutionChatMessageRequestSchema.parse({ target, messageId: message.id }) })
  },
}

function ExecutionChat({ resolved, onSelectTarget }: WorkflowExecutionChatViewProps) {
  return <ExecutionChatPanel visible target={resolved.target} name={resolved.agent.displayName} source={executionSource}
    onOpenContinuation={receipt => {
      if (receipt.continuationExecution) onSelectTarget({ kind: 'workflow_execution', agent: resolved.target.agent,
        execution: receipt.continuationExecution }, receipt.continuationExecution.workflowVersionId)
    }} />
}

function OutsideRunChat({ resolved }: WorkflowOutsideRunChatViewProps) {
  return <LiveAgentConversation context={resolved.agent} name="Agent chat" />
}

const collaborationSlots: CollaborationUISlots = { executionChatViews: { ExecutionChat, OutsideRunChat },
  browserProfiles: scope => <BrowserProfileManager computer={'computer' in scope ? scope.computer : undefined} />,
  computerBrowserProfiles: target => <ComputerBrowserProfiles target={target} />,
  nodeBrowser: props => <NodeBrowserFields {...props} />,
  workflow: () => ({ browser: props => <WorkflowBrowser {...props} />, beforeBrowserHide: returnBrowserControl }),
}

export function CollaborationFeatures({ children }: { children: ReactNode }) {
  return <CollaborationUIProvider value={collaborationSlots}>{children}<BrowserSetupHost /><BrowserRecovery /></CollaborationUIProvider>
}

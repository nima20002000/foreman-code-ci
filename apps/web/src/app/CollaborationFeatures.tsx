import type { ReactNode } from 'react'
import { CollaborationUIProvider, type CollaborationUISlots } from '../shared/ui/collaborationSlots'
import { WorkflowExecutionConversation } from '../features/conversations/delivery/WorkflowExecutionConversation'
import { LiveAgentConversation } from '../features/conversations/agentChat/LiveAgentConversation'
import type { WorkflowOutsideRunChatViewProps } from '../features/workflow-hierarchy/execution-chat/types'

function OutsideRunChat({ resolved }: WorkflowOutsideRunChatViewProps) {
  return <LiveAgentConversation context={resolved.agent} name="Agent chat" />
}

const collaborationSlots: CollaborationUISlots = { executionChatViews: { ExecutionChat: WorkflowExecutionConversation, OutsideRunChat } }

export function CollaborationFeatures({ children }: { children: ReactNode }) {
  return <CollaborationUIProvider value={collaborationSlots}>{children}</CollaborationUIProvider>
}

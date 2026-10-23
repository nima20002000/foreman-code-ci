import { BrowserProfileManager, ComputerBrowserProfiles, NodeBrowserFields, BrowserSetupHost } from './BrowserProfileFeatures'
import { WorkflowBrowser } from './WorkflowBrowser'
import { WorkflowBrowserSidebar } from './WorkflowBrowserSidebar'
import { returnBrowserControl } from './browserRecovery'
import { BrowserRecovery } from './BrowserRecovery'
import { useMemo, type ReactNode } from 'react'
import { CollaborationUIProvider, useCollaborationUISlots, type CollaborationUISlots } from '../shared/ui/collaborationSlots'
import { WorkflowExecutionConversation } from '../features/conversations/delivery/WorkflowExecutionConversation'
import { LiveAgentConversation } from '../features/conversations/agentChat/LiveAgentConversation'
import { useManagedAgentsQuery, useManagedWorkflowQuery } from '../shared/api/query'
import type { WorkflowOutsideRunChatViewProps } from '../features/workflow-hierarchy/execution-chat/types'
import { useBoardAuthoring } from '../features/workflow-board/context'

function OutsideRunChat({ resolved }: WorkflowOutsideRunChatViewProps) {
  // The resolution carries ids only; the saved node supplies the name that tells the person whose chat this is.
  const workflow = useManagedWorkflowQuery(resolved.agent.workspaceId, resolved.agent.workflowId)
  const node = workflow.data?.workflow.nodes.find(item => item.id === resolved.agent.workflowNodeId)
  // A draft chat's node is not saved yet; its saved Agent still has a name.
  const agents = useManagedAgentsQuery(resolved.agent.workspaceId, !resolved.workflowVersionId)
  const agent = agents.data?.items.find(item => item.agent.id === resolved.agent.agentId)?.agent
  // The Board's current browser switch reaches this chat without saving the workflow.
  const browser = useBoardAuthoring()?.draftNodeBrowser?.(resolved.agent.workflowNodeId)
  return <LiveAgentConversation context={resolved.agent} name={node?.name ?? node?.label ?? agent?.name ?? 'Agent chat'}
    {...(browser !== undefined ? { browser } : {})} />
}

const collaborationSlots: CollaborationUISlots = { executionChatViews: { ExecutionChat: WorkflowExecutionConversation, OutsideRunChat },
  browserProfiles: scope => <BrowserProfileManager computer={'computer' in scope ? scope.computer : undefined} />,
  computerBrowserProfiles: target => <ComputerBrowserProfiles target={target} />,
  nodeBrowser: props => <NodeBrowserFields {...props} />,
  workflow: () => ({ browser: props => <WorkflowBrowser {...props} />, browserSidebar: props => <WorkflowBrowserSidebar {...props} />,
    beforeBrowserHide: returnBrowserControl }),
}

/** Production defaults; an enclosing provider (a host or test) supplies its own slots and wins. */
export function CollaborationFeatures({ children }: { children: ReactNode }) {
  const supplied = useCollaborationUISlots()
  const slots = useMemo(() => ({ ...collaborationSlots, ...supplied }), [supplied])
  return <CollaborationUIProvider value={slots}>{children}<BrowserSetupHost /><BrowserRecovery /></CollaborationUIProvider>
}

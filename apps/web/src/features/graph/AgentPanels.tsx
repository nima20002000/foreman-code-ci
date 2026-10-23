import type { AgentChatContext } from '@foreman-code/contracts/agent-chat'
import { EmptyState } from '../../shared/ui/nocturne'
import { useHarnessSessionEpoch } from '../../shared/api/harnessSettings'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'
import { AgentConversation, AgentChatHeader, agentChatContextKey } from '../conversations'
import '../conversations/agentChat/agentChat.css'

export function AgentChatPanel({ name, role, activity, running, runLabel, context, onClose, onNewConversation }: {
  name: string; role?: string; activity?: string; running?: boolean; runLabel?: string
  context?: AgentChatContext; onClose?: () => void; onNewConversation?: () => void
}) {
  const generation = useHarnessSessionEpoch()
  if (sessionIsSwitching()) return null
  return <div className="agent-chat-panel">
    {context ? <AgentConversation key={`${generation}:${agentChatContextKey(context)}`} context={context} name={name}
      role={role} activity={activity} runLabel={runLabel} onClose={onClose} onNewConversation={onNewConversation} />
      : <><AgentChatHeader name={name} state={running ? 'Working' : 'Idle'} detail={activity} onClose={onClose} />
        <EmptyState icon="info" title="Select a saved Agent to chat" /></>}
  </div>
}

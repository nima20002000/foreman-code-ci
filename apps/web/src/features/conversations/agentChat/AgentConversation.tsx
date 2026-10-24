import { ChatAttachmentBoundary, agentChatContextKey } from '../../chat-core'
import { identityEpoch } from '../../../shared/api/protectedChatStorage'
import { AgentConversationContent, type AgentConversationContentProps } from './AgentConversationContent'

type AgentConversationProps = Omit<AgentConversationContentProps, 'canonical' | 'browser' | 'onRecover'>

/** Mounted through the existing Board AgentChatPanel. Server state stays in Query. */
export function AgentConversation(props: AgentConversationProps) {
  return <ChatAttachmentBoundary><AgentConversationContent key={`${identityEpoch()}:${agentChatContextKey(props.context)}:${props.selection?.executionId ?? ''}`} {...props} /></ChatAttachmentBoundary>
}

import { ChatAttachmentBoundary } from '../ChatAttachmentBoundary'
import { identityEpoch } from '../../../shared/api/protectedChatStorage'
import { agentChatContextKey } from './model'
import { AgentConversationContent, type AgentConversationContentProps } from './AgentConversationContent'

type LiveAgentConversationProps = Omit<AgentConversationContentProps, 'canonical' | 'selection'> & {
  visible?: boolean
}

/** The shared rail uses canonical delivery and the Board's current browser setting outside a Run. */
export function LiveAgentConversation(props: LiveAgentConversationProps) {
  return props.visible === false ? null : <ChatAttachmentBoundary><AgentConversationContent key={`${identityEpoch()}:${agentChatContextKey(props.context)}`} {...props} canonical /></ChatAttachmentBoundary>
}

import type { WorkflowExecutionChatTarget } from '@foreman-code/contracts'
import { getConversationDraft, useConversationDraftStore } from '../conversationDraftStore'

export const executionChatDraftKey = (target: WorkflowExecutionChatTarget) => `execution-chat:${JSON.stringify(target)}`

export function appendExecutionChatDraft(target: WorkflowExecutionChatTarget, text: string) {
  const key = executionChatDraftKey(target), current = getConversationDraft(key)
  if (!current.includes(text)) useConversationDraftStore.getState().setDraft(key, current ? `${current.trimEnd()} ${text}` : text)
}

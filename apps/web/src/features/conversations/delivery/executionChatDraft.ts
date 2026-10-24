import type { WorkflowExecutionChatTarget } from '@foreman-code/contracts'
import { agentChatDraftKey } from '../agentChat/model'
import { getConversationDraft, useConversationDraftStore } from '../conversationDraftStore'

export const executionChatDraftKey = (target: WorkflowExecutionChatTarget) => target.kind === 'workflow_execution'
  ? agentChatDraftKey({ ...target.agent, runId: target.execution.runId }, target.execution.executionId) : `execution-chat:${JSON.stringify(target)}`

export function appendExecutionChatDraft(target: WorkflowExecutionChatTarget, text: string) {
  const key = executionChatDraftKey(target), current = getConversationDraft(key)
  if (!current.includes(text)) useConversationDraftStore.getState().setDraft(key, current ? `${current.trimEnd()} ${text}` : text)
}

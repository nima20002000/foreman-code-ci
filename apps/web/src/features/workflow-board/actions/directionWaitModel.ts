import { useQuery } from '@tanstack/react-query'
import type { RepeatGraphScopeCurrent, RunDirectionWait } from '@foreman-code/contracts/current'
import { readWorkflowDraft, useWorkflowDraftStore, workflowDraftKey, insertMention } from '../../workflow-chat'
import type { InteractionWait } from '../inspect/runLiveStatus'
import { runActionsClient, type RunActionSelection } from './client'
import { actionKey } from './state'

type Scope = RunActionSelection & Partial<Pick<RepeatGraphScopeCurrent, 'workflowVersionId'>>

/** The same Run status read as Run controls; present while a Master waits for the user's direction. */
export function useRunDirectionWait(scope: Scope | undefined): RunDirectionWait | undefined {
  const status = useQuery({ queryKey: actionKey(scope ?? { workspaceId: '', workflowId: '', runId: '' }, 'status', scope?.workflowVersionId ?? null),
    enabled: !!scope, queryFn: ({ signal }) => runActionsClient.status(scope!, { signal }), staleTime: 1000, gcTime: 0,
    refetchInterval: query => query.state.error || query.state.data?.executionState === 'completed' ? false : 5000 })
  return status.data?.executionState === 'completed' ? undefined : status.data?.directionWait
}

/** The waiting node reads as waiting on the user, like any other pending answer. */
export function withDirectionWait(waits: Map<string, InteractionWait>, direction: RunDirectionWait | undefined) {
  if (!direction) return waits
  const next = new Map(waits)
  next.set(direction.workflowNodeId, { interactionId: direction.executionId, label: 'Waiting for you' })
  return next
}

/** The reply that ends the Run with the Master's remaining findings accepted as they are. */
export const acceptFindingsDirection = 'Accept the remaining findings as they are and finish the Run now: '
  + 'return finish with remainingFindings [] and keep those findings in latestDeliverable.'

/** Puts "@Master " at the start of the group chat draft, unless that draft already mentions the Master,
 * then adds `text` at the end unless the draft already holds it. */
export function mentionInGroupChat(scope: { workspaceId: string; workflowId: string }, direction: RunDirectionWait, text?: string) {
  const key = workflowDraftKey(scope)
  let current = readWorkflowDraft(key)
  if (!current.mentions.some(mention => mention.workflowNodeId === direction.workflowNodeId)) {
    const added = insertMention(current.body, current.mentions,
      { displayName: direction.agentName, workflowNodeId: direction.workflowNodeId }, 0)
    current = { ...current, body: added.body, mentions: added.mentions }
  }
  if (text && !current.body.includes(text)) current = { ...current, body: `${current.body.trimEnd()} ${text}` }
  useWorkflowDraftStore.getState().save(key, current)
}

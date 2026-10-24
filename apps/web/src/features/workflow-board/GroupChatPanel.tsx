import { useMemo } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { useQuery } from '@tanstack/react-query'
import type { BoardSidePanel } from '@foreman-code/contracts/current'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { WorkflowChatPanel } from '../workflow-chat'
import { groupTargetResolver, readGroupParticipants } from './groupChatClient'

export function GroupChatPanel({ workspaceId, workflowId, runId, onSelect }: {
  workspaceId: string; workflowId: string; runId?: string
  onSelect(selection: BoardSidePanel): void
}) {
  const location = useLocation()
  const navigate = useNavigate()
  const participants = useQuery({ queryKey: ['workflow-chat-participants', identityEpoch(), workspaceId, workflowId, runId],
    queryFn: ({ signal }) => readGroupParticipants(workspaceId, workflowId, runId, { signal }),
    // A Run pins its saved Agents; the workflow's current Agents change with every save, so reread when the panel reopens.
    staleTime: runId ? Infinity : 0 })
  const resolveTargets = useMemo(() => groupTargetResolver(runId), [runId])
  return <WorkflowChatPanel workspaceId={workspaceId} workflowId={workflowId} visible
    participants={participants.data ?? []} participantsLoading={participants.isPending}
    participantsError={participants.error?.message} retryParticipants={() => void participants.refetch()}
    currentRunId={runId} resolveTargets={resolveTargets}
    selection={{ runId: location.search.groupRunId, postId: location.search.groupPostId, receiptId: location.search.groupReceiptId }}
    onSelectionChange={selection => {
      void navigate({ to: '/workspaces/$workspaceId', params: { workspaceId }, hash: true,
        search: previous => previous.workflowId !== workflowId ? previous : { ...previous,
          groupRunId: selection.runId, groupPostId: selection.postId, groupReceiptId: selection.receiptId } })
    }}
    onOpenAgent={(post, receipt) => {
      const target = receipt?.target
      if (target && target.kind !== 'operator_conversation') {
        onSelect({ kind: 'agent', nodeId: target.agent.workflowNodeId, tab: 'chat',
          ...(target.kind === 'workflow_execution' ? { executionId: target.execution.executionId } : {}) })
      } else if (post.author.kind === 'agent') onSelect({ kind: 'agent', nodeId: post.author.agent.workflowNodeId, tab: 'chat' })
    }} />
}

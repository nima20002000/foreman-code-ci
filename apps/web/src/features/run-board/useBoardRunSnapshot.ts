import { useEffect, useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RepeatGraphScopeCurrent } from '@foreman-code/contracts/current'
import { nextDraftKey } from '../board-core'
import { useGraphDraftStore } from '../graph'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { isRunAccessError, runsSelectorApi } from '../runs-selector'
import { isActiveCi } from '../workflow-board'
import { runBoardCi } from './model'

export type BoardRun = { workspaceId: string; workflowId: string; runId: string; live: boolean }

/** One snapshot read supplies both the Board overlay and its controls' immutable Run pins. */
export function useBoardRunSnapshot(run: BoardRun | undefined, visible: boolean) {
  const read = useQuery({
    queryKey: ['board-run-overlay', run?.workspaceId, run?.workflowId, run?.runId],
    queryFn: ({ signal }) => runsSelectorApi.snapshot({ workspaceId: run!.workspaceId, workflowId: run!.workflowId, runId: run!.runId }, { signal }),
    enabled: !!run && visible,
    refetchInterval: query => {
      if (!visible || isRunAccessError(query.state.error)) return false
      const result = query.state.data
      const unfinishedCi = result?.snapshot.kind === 'available'
        && [...runBoardCi(result.snapshot, result.activitySnapshot).values()].some(isActiveCi)
      return run?.live || unfinishedCi ? 3000 : false
    },
    staleTime: 0,
  })
  const { refetch } = read
  useEffect(() => {
    // The summary and Activity arrive independently; finishing always takes a final Activity read.
    if (run?.runId && !run.live && visible) void refetch({ cancelRefetch: false })
  }, [run?.workspaceId, run?.workflowId, run?.runId, run?.live, visible, refetch])
  const denied = useProtectedAccessError(read)
  const result = denied || read.isError ? undefined : read.data
  // Only a Run of the draft's saved version belongs on its nodes and in its execution panels.
  const savedVersionId = useGraphDraftStore(state => {
    if (!run) return undefined
    const context = state.nextDrafts[nextDraftKey(run.workspaceId, run.workflowId)]?.context
    return (context?.savedDraft ?? context?.draft)?.baseWorkflowVersionId ?? undefined
  })
  const snapshot = run && result?.snapshot.kind === 'available' && result.snapshot.runId === run.runId
    && result.snapshot.workflowVersionId === savedVersionId ? result.snapshot : undefined
  const activity = snapshot ? result?.activitySnapshot : undefined
  const scope = useMemo<RepeatGraphScopeCurrent | undefined>(() => snapshot ? {
    workspaceId: snapshot.workspaceId, workflowId: snapshot.workflowId, runId: snapshot.runId,
    workflowVersionId: snapshot.workflowVersionId, executionSemanticsVersion: 3,
  } : undefined, [snapshot])
  return { ...read, snapshot, activity, scope }
}


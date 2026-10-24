import { useMemo } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { RepeatGraphScopeCurrent } from '@foreman-code/contracts/current'
import { isRunAccessError, runsSelectorApi } from '../runs-selector'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'

export type BoardRun = { workspaceId: string; workflowId: string; runId: string; live: boolean }

export function useBoardRunSnapshot(run: BoardRun | undefined, visible: boolean) {
  const read = useQuery({
    queryKey: ['board-run-overlay', run?.workspaceId, run?.workflowId, run?.runId],
    queryFn: ({ signal }) => runsSelectorApi.snapshot({ workspaceId: run!.workspaceId, workflowId: run!.workflowId, runId: run!.runId }, { signal }),
    enabled: !!run && visible,
    refetchInterval: query => !run?.live || isRunAccessError(query.state.error) ? false : 3000,
    staleTime: 0,
  })
  const denied = useProtectedAccessError(read)
  const result = denied || read.isError ? undefined : read.data
  const snapshot = run && result?.snapshot.kind === 'available' && result.snapshot.runId === run.runId ? result.snapshot : undefined
  const activity = snapshot ? result?.activitySnapshot : undefined
  const scope = useMemo<RepeatGraphScopeCurrent | undefined>(() => snapshot ? {
    workspaceId: snapshot.workspaceId, workflowId: snapshot.workflowId, runId: snapshot.runId,
    workflowVersionId: snapshot.workflowVersionId, executionSemanticsVersion: 3,
  } : undefined, [snapshot])
  return { snapshot, activity, scope }
}


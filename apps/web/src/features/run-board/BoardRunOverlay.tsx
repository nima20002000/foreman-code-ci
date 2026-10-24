import { useEffect, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { CiActivity } from '@foreman-code/contracts'
import type { RunBoardEdgeSnapshot } from '@foreman-code/contracts/run-snapshots'
import { RunLiveNodes, RunLivePulses, RunLiveCi, type RunLivePulse } from '../board-core'
import { isRunAccessError, runsSelectorApi } from '../runs-selector'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { runBoardCi } from './model'
import { useRunLiveNodes } from './useRunLiveNodes'
import { ciJobRefreshing, ciNodeActivities, isActiveCi, runCiApi, runInspectionQueryKey } from '../workflow-board'

export type BoardRun = { workspaceId: string; workflowId: string; runId: string; live: boolean }

const noEdges: readonly RunBoardEdgeSnapshot[] = []
const noPulses: ReadonlyMap<string, readonly RunLivePulse[]> = new Map()
const noCis: ReadonlyMap<string, CiActivity> = new Map()

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
  return read
}

/** The workflow's latest Run shown on the Board itself: live node states and hand-off lights while it runs,
 * its final states afterwards. Nodes and lines are matched by id, so a node added since that Run stays a draft node.
 * The providers are always mounted, so a Run appearing or leaving never remounts the draft beneath them. */
export function BoardRunOverlay({ run, read, visible, children }: { run?: BoardRun; read: ReturnType<typeof useBoardRunSnapshot>; visible: boolean; children: ReactNode }) {
  const denied = useProtectedAccessError(read)
  const result = denied || read.isError ? undefined : read.data
  const snapshot = run && result?.snapshot.kind === 'available' && result.snapshot.runId === run.runId ? result.snapshot : undefined
  const activity = snapshot ? result?.activitySnapshot : undefined
  const scope = useMemo(() => ({ workspaceId: snapshot?.workspaceId ?? run?.workspaceId ?? '', workflowId: snapshot?.workflowId ?? run?.workflowId ?? '',
    runId: snapshot?.runId ?? run?.runId ?? '', workflowVersionId: snapshot?.workflowVersionId ?? '', executionSemanticsVersion: 3 as const }),
  [snapshot?.workspaceId, snapshot?.workflowId, snapshot?.runId, snapshot?.workflowVersionId, run?.workspaceId, run?.workflowId, run?.runId])
  const names = useMemo(() => new Map((snapshot?.nodes ?? []).map(node => [node.id, node.name])), [snapshot?.nodes])
  const ciList = useQuery({
    queryKey: [...runInspectionQueryKey(scope), 'ci-jobs'], enabled: visible && !!snapshot,
    queryFn: ({ signal }) => runCiApi.list({ workspaceId: scope.workspaceId, runId: scope.runId }, { signal }),
    refetchInterval: query => !visible || isRunAccessError(query.state.error) ? false
      : run?.live || query.state.data?.jobs.some(ciJobRefreshing) ? 1500 : false,
  })
  const ciDenied = useProtectedAccessError(ciList)
  const jobs = !ciDenied && !ciList.isError && ciList.data?.runId === scope.runId ? ciList.data.jobs : undefined
  const ci = useMemo(() => snapshot ? { scope, names, jobs, truncated: !ciDenied && (ciList.data?.truncated ?? false),
    error: !!ciDenied || ciList.isError, loading: ciList.isPending, readError: ciDenied ?? ciList.error,
    onRefresh: () => { void ciList.refetch() } } : undefined,
  [snapshot, scope, names, jobs, ciDenied, ciList.data?.truncated, ciList.isError, ciList.isPending, ciList.error, ciList.refetch])
  const cis = useMemo(() => snapshot ? new Map([...runBoardCi(snapshot, activity), ...ciNodeActivities(jobs ?? [])]) : noCis,
    [snapshot, activity, jobs])
  const live = useRunLiveNodes(scope, names, cis, visible && !!snapshot, snapshot?.edges ?? noEdges)
  return <RunLiveNodes.Provider value={snapshot ? live.nodes : undefined}>
    <RunLivePulses.Provider value={snapshot ? live.pulses : noPulses}><RunLiveCi.Provider value={ci}>{children}</RunLiveCi.Provider></RunLivePulses.Provider>
  </RunLiveNodes.Provider>
}

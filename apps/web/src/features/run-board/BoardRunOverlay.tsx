import { useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import { RunLiveNodes, RunLivePulses } from '../board-core'
import { isRunAccessError, runsSelectorApi } from '../runs-selector'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { runBoardCi, type AvailableRunBoardSnapshot } from './model'
import { useRunLiveNodes } from './useRunLiveNodes'
import type { ActivitySnapshotV1 } from '@foreman-code/contracts'

export type BoardRun = { workspaceId: string; workflowId: string; runId: string; live: boolean }

/** The workflow's latest Run shown on the Board itself: live node states and hand-off lights while it runs,
 * its final states afterwards. Nodes and lines are matched by id, so a node added since that Run stays a draft node. */
export function BoardRunOverlay({ run, visible, children }: { run?: BoardRun; visible: boolean; children: ReactNode }) {
  const snapshot = useQuery({
    queryKey: ['board-run-overlay', run?.workspaceId, run?.workflowId, run?.runId],
    queryFn: ({ signal }) => runsSelectorApi.snapshot({ workspaceId: run!.workspaceId, workflowId: run!.workflowId, runId: run!.runId }, { signal }),
    enabled: !!run && visible,
    refetchInterval: query => !run?.live || isRunAccessError(query.state.error) ? false : 3000,
    staleTime: 0,
  })
  const denied = useProtectedAccessError(snapshot)
  const data = denied || snapshot.isError ? undefined : snapshot.data
  if (!run || data?.snapshot.kind !== 'available' || data.snapshot.runId !== run.runId) return <>{children}</>
  return <RunStates snapshot={data.snapshot} activity={data.activitySnapshot} visible={visible}>{children}</RunStates>
}

function RunStates({ snapshot, activity, visible, children }: {
  snapshot: AvailableRunBoardSnapshot; activity?: ActivitySnapshotV1; visible: boolean; children: ReactNode
}) {
  const scope = useMemo(() => ({ workspaceId: snapshot.workspaceId, workflowId: snapshot.workflowId, runId: snapshot.runId,
    workflowVersionId: snapshot.workflowVersionId, executionSemanticsVersion: 3 as const }),
  [snapshot.workspaceId, snapshot.workflowId, snapshot.runId, snapshot.workflowVersionId])
  const names = useMemo(() => new Map(snapshot.nodes.map(node => [node.id, node.name])), [snapshot.nodes])
  const cis = useMemo(() => runBoardCi(snapshot, activity), [snapshot, activity])
  const live = useRunLiveNodes(scope, names, cis, visible, snapshot.edges)
  return <RunLiveNodes.Provider value={live.nodes}><RunLivePulses.Provider value={live.pulses}>{children}</RunLivePulses.Provider></RunLiveNodes.Provider>
}

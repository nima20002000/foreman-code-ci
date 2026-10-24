import { useEffect, useMemo, type ReactNode } from 'react'
import { useQuery } from '@tanstack/react-query'
import type { CiActivity } from '@foreman-code/contracts'
import type { RunBoardEdgeSnapshot } from '@foreman-code/contracts/run-snapshots'
import { RunLiveNodes, RunLivePulses, nextDraftKey, type RunLivePulse } from '../board-core'
import { useGraphDraftStore } from '../graph'
import { isRunAccessError, runsSelectorApi } from '../runs-selector'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import { runBoardCi } from './model'
import { useRunLiveNodes } from './useRunLiveNodes'

export type BoardRun = { workspaceId: string; workflowId: string; runId: string; live: boolean }

const noEdges: readonly RunBoardEdgeSnapshot[] = []
const noPulses: ReadonlyMap<string, readonly RunLivePulse[]> = new Map()
const noCis: ReadonlyMap<string, CiActivity> = new Map()

/** The workflow's latest Run shown on the Board itself: live node states and hand-off lights while it runs,
 * its final states afterwards. Nodes and lines are matched by id, so a node added since that Run stays a draft node.
 * The providers are always mounted, so a Run appearing or leaving never remounts the draft beneath them. */
export function BoardRunOverlay({ run, visible, onPainted, children }: {
  run?: BoardRun; visible: boolean; onPainted?(runId: string | undefined): void; children: ReactNode
}) {
  const read = useQuery({
    queryKey: ['board-run-overlay', run?.workspaceId, run?.workflowId, run?.runId],
    queryFn: ({ signal }) => runsSelectorApi.snapshot({ workspaceId: run!.workspaceId, workflowId: run!.workflowId, runId: run!.runId }, { signal }),
    enabled: !!run && visible,
    refetchInterval: query => !run?.live || isRunAccessError(query.state.error) ? false : 3000,
    staleTime: 0,
  })
  const denied = useProtectedAccessError(read)
  const result = denied || read.isError ? undefined : read.data
  // Only a Run of the draft's own saved version belongs on these nodes; an older version's facts stay in its saved view.
  const savedVersionId = useGraphDraftStore(state => {
    if (!run) return undefined
    const context = state.nextDrafts[nextDraftKey(run.workspaceId, run.workflowId)]?.context
    return (context?.savedDraft ?? context?.draft)?.baseWorkflowVersionId ?? undefined
  })
  const snapshot = run && result?.snapshot.kind === 'available' && result.snapshot.runId === run.runId
    && result.snapshot.workflowVersionId === savedVersionId ? result.snapshot : undefined
  const activity = snapshot ? result?.activitySnapshot : undefined
  const painted = snapshot?.runId
  useEffect(() => { onPainted?.(painted) }, [onPainted, painted])
  const scope = useMemo(() => ({ workspaceId: snapshot?.workspaceId ?? run?.workspaceId ?? '', workflowId: snapshot?.workflowId ?? run?.workflowId ?? '',
    runId: snapshot?.runId ?? run?.runId ?? '', workflowVersionId: snapshot?.workflowVersionId ?? '', executionSemanticsVersion: 3 as const }),
  [snapshot?.workspaceId, snapshot?.workflowId, snapshot?.runId, snapshot?.workflowVersionId, run?.workspaceId, run?.workflowId, run?.runId])
  const names = useMemo(() => new Map((snapshot?.nodes ?? []).map(node => [node.id, node.name])), [snapshot?.nodes])
  const cis = useMemo(() => snapshot ? runBoardCi(snapshot, activity) : noCis, [snapshot, activity])
  const live = useRunLiveNodes(scope, names, cis, visible && !!snapshot, snapshot?.edges ?? noEdges)
  return <RunLiveNodes.Provider value={snapshot ? live.nodes : undefined}>
    <RunLivePulses.Provider value={snapshot ? live.pulses : noPulses}>{children}</RunLivePulses.Provider>
  </RunLiveNodes.Provider>
}

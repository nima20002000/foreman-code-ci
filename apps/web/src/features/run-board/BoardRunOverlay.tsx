import { useMemo, type ReactNode } from 'react'
import type { CiActivity } from '@foreman-code/contracts'
import type { RunBoardEdgeSnapshot } from '@foreman-code/contracts/run-snapshots'
import { RunLiveNodes, RunLivePulses, RunDisplayedSnapshot, type RunLivePulse } from '../board-core'
import { runBoardCi } from './model'
import { useRunLiveNodes } from './useRunLiveNodes'
import type { useBoardRunSnapshot } from './useBoardRunSnapshot'

const noEdges: readonly RunBoardEdgeSnapshot[] = []
const noPulses: ReadonlyMap<string, readonly RunLivePulse[]> = new Map()
const noCis: ReadonlyMap<string, CiActivity> = new Map()

/** The workflow's latest Run shown on the Board itself: live node states and hand-off lights while it runs,
 * its final states afterwards. Nodes and lines are matched by id, so a node added since that Run stays a draft node.
 * The providers are always mounted, so a Run appearing or leaving never remounts the draft beneath them. */
export function BoardRunOverlay({ displayed, visible, children }: {
  displayed: ReturnType<typeof useBoardRunSnapshot>; visible: boolean; children: ReactNode
}) {
  const { snapshot, activity, scope } = displayed
  const names = useMemo(() => new Map((snapshot?.nodes ?? []).map(node => [node.id, node.name])), [snapshot?.nodes])
  const cis = useMemo(() => snapshot ? runBoardCi(snapshot, activity) : noCis, [snapshot, activity])
  const live = useRunLiveNodes(scope ?? { workspaceId: '', workflowId: '', runId: '', workflowVersionId: '', executionSemanticsVersion: 3 }, names, cis, visible && !!snapshot, snapshot?.edges ?? noEdges)
  return <RunDisplayedSnapshot.Provider value={snapshot}><RunLiveNodes.Provider value={snapshot ? live.nodes : undefined}>
    <RunLivePulses.Provider value={snapshot ? live.pulses : noPulses}>{children}</RunLivePulses.Provider>
  </RunLiveNodes.Provider></RunDisplayedSnapshot.Provider>
}

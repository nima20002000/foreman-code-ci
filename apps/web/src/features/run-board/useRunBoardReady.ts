import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { useSelectedRunSnapshot } from '../runs-selector/query'
import { useRunVersionQuery } from '../workflow-board/inspect/queries'

/** True once the selected Run can be drawn in full (or has nothing to draw), so the Board never flashes a loading
 * screen between the draft and the Run: its places come from the Run's snapshot and saved version together. */
export function useRunBoardReady(selection: SelectedRunState) {
  const query = useSelectedRunSnapshot(selection)
  const snapshot = query.snapshot
  const version = useRunVersionQuery({ ...selection.identity, runId: selection.identity.runId ?? '',
    workflowVersionId: snapshot?.kind === 'available' ? snapshot.workflowVersionId : '', executionSemanticsVersion: 3 },
  snapshot?.kind === 'available')
  if (!selection.active || selection.invalid || selection.identity.runId === null) return true
  if (!snapshot) return query.isError
  return snapshot.kind !== 'available' || !!version.data || version.isError
}

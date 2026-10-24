import { useSelectedRun } from '../runs-selector'
import type { AvailableRunBoardSnapshot } from './model'
import { RunNodeInspector } from './RunNodeInspector'

/** The saved Run inspector inside the retained draft panel, with the same visit fencing as history. */
export function BoardRunNodeInspector({ snapshot, nodeId, executionId, onInspect }: {
  snapshot: AvailableRunBoardSnapshot; nodeId: string; executionId?: string
  onInspect(nodeId?: string, executionId?: string): void
}) {
  const selection = useSelectedRun(snapshot, snapshot.runId)
  return <RunNodeInspector key={selection.generation.id} selection={selection} snapshot={snapshot}
    nodeId={nodeId} executionId={executionId} onInspect={onInspect} closable={false} />
}

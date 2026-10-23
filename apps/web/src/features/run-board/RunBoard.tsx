import { useState } from 'react'
import { createPortal } from 'react-dom'
import type { RunBoardNodeSnapshot } from '@foreman-code/contracts/run-snapshots'
import type { SelectedRunState } from '../runs-selector/useSelectedRun'
import { isRunAccessError, runReadErrorLabel, useSelectedRunSnapshot } from '../runs-selector/query'
import { Button, EmptyState, ErrorState } from '../../shared/ui/nocturne'
import { ApiError } from '../../shared/api/client'
import { SelectedNodePlacement } from '../node-placement/SelectedNodePlacement'
import { RunNodeInspector } from './RunNodeInspector'
import { useRunNodeInspectionNavigation } from './inspectionNavigation'
import { RunBoardCanvas } from './RunBoardCanvas'
import { useRunVersionQuery } from '../workflow-board/inspect/queries'
import { SavedWorkflowWorktree } from '../workflow-board/SavedWorkflowWorktree'
import './runBoard.css'
import { useWorkflowBoard } from '../workflow-board/context'
import { useHierarchy } from '../workflow-hierarchy/queries'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'
import type { AvailableRunBoardSnapshot } from './model'

export type RunBoardProps = { selection: SelectedRunState; hidden?: boolean }

/** Accept the SAME selected-Run hook result as RunsSelector, including its visit
 * generation. A naked runId loses the A -> B -> A fence. Query owns every read.
 */
export function RunBoard({ selection, hidden = false }: RunBoardProps) {
  const query = useSelectedRunSnapshot(selection)
  const inspection = useRunNodeInspectionNavigation(selection)
  const board = useWorkflowBoard()
  if (!selection.active) return null
  if (selection.invalid) return <section className="run-board" aria-label="Selected Run board"><p role="status">Invalid Run</p></section>
  if (selection.identity.runId === null) return null

  const current = selection.isCurrent(selection.generation)
  const snapshot = current ? query.snapshot : undefined
  const failed = current && query.isError && !snapshot
  const loading = !failed && !snapshot
  return <section className={!board && inspection.nodeId ? 'run-board run-board-inspecting' : 'run-board'}
    aria-label="Selected Run board" aria-busy={loading} hidden={hidden}
    data-run-id={selection.identity.runId} data-generation={selection.generation.id}>
    {query.isError && snapshot ? <p role="status" className="run-board-stale">Couldn’t refresh this run. Showing the last read.
      {' '}<Button size="sm" variant="ghost" aria-label="Retry Run refresh" onClick={() => void query.refetch()}>Try again</Button></p> : null}
    {failed ? isRunAccessError(query.error)
      ? <EmptyState icon="history" title={runReadErrorLabel(query.error)}
        description={ApiError.is(query.error) && query.error.status === 404 ? 'This run no longer exists, or the link is wrong.' : 'You can’t open this run.'}
        action={<Button onClick={() => void selection.selectRun(null)}>Back to workflow</Button>} />
      : <ErrorState title="Couldn’t load this run" description="Check the connection and try again."
        onRetry={() => { if (selection.isCurrent(selection.generation)) void query.refetch() }} retrying={query.isFetching} />
    : loading ? <p role="status">{query.isPaused ? 'Offline' : 'Loading…'}</p>
      : snapshot?.kind === 'unavailable' ? <p role="status">Snapshot unavailable</p>
      : snapshot?.kind === 'available' ? <RunBoardContents selection={selection} snapshot={snapshot} inspection={inspection}
        activitySnapshot={query.activitySnapshot} /> : null}
  </section>
}

function RunBoardContents({ selection, snapshot, inspection, activitySnapshot }: {
  selection: SelectedRunState; snapshot: AvailableRunBoardSnapshot;
  inspection: ReturnType<typeof useRunNodeInspectionNavigation>;
  activitySnapshot: ReturnType<typeof useSelectedRunSnapshot>['activitySnapshot']
}) {
  const board = useWorkflowBoard()
  const visible = board?.canvasVisible !== false && !board?.memoryOpen
  const version = useRunVersionQuery({ workspaceId: snapshot.workspaceId, workflowId: snapshot.workflowId, runId: snapshot.runId,
    workflowVersionId: snapshot.workflowVersionId, executionSemanticsVersion: 3 })
  const definition = version.data?.version.id === snapshot.workflowVersionId ? version.data.version.definition : undefined
  const hierarchy = useHierarchy({ workspaceId: snapshot.workspaceId, workflowId: snapshot.workflowId, runId: snapshot.runId },
    { enabled: visible })
  const denied = useProtectedAccessError(hierarchy)
  const saved = !denied && hierarchy.data?.workflowVersionId === snapshot.workflowVersionId ? hierarchy.data : undefined
  const panel = board?.sidePanel
  const inspect = visible && !!inspection.nodeId && (!board || panel?.kind === 'agent' && panel.tab === 'details')
  const details = inspect ? <RunNodeInspector key={`inspector:${selection.generation.id}:${inspection.nodeId}`}
    selection={selection} snapshot={snapshot} nodeId={inspection.nodeId!} hierarchy={saved}
    executionId={inspection.executionId} onInspect={inspection.inspect} closable={!board} /> : null
  const settings = panel?.kind === 'agent' && panel.tab === 'settings' && !board?.memoryOpen
    ? <section aria-label="Saved Agent settings"><h3>{snapshot.nodes.find(node => node.id === panel.nodeId)?.name ?? panel.nodeId}</h3>
      <p>This Run keeps its saved Agent configuration. Return to the draft to edit settings for future Runs.</p></section> : null
  // Inside the Board the caption sits in its floating toolbar, so the two never cover each other.
  const caption = <>
    <RunDefaultWorktree selection={selection} workflowVersionId={snapshot.workflowVersionId} />
    {visible ? <SelectedRunComputers key={`placement:${selection.generation.id}`} selection={selection} nodes={snapshot.nodes} /> : null}
    <span className="run-board-label">Read only</span>
  </>
  return <>
    {board?.runCaptionHost ? createPortal(caption, board.runCaptionHost) : <header className="run-board-header">{caption}</header>}
    {/* Drawn once the saved version is read, so nodes appear at their saved places and never jump there. */}
    {!snapshot.nodes.length ? <p role="status">No nodes</p> : definition || version.isError
      ? <RunBoardCanvas key={selection.generation.id} snapshot={snapshot} visible={visible} definition={definition}
        hierarchy={saved} activitySnapshot={activitySnapshot} onInspectNode={inspection.inspect} /> : null}
    {board ? board.sidePanelHost ? createPortal(<>{details}{settings}
      {!visible && !board.memoryOpen && panel?.kind === 'agent' && panel.tab === 'details'
        ? <p>Open Graph to inspect this saved execution. Your selection is retained.</p> : null}
    </>, board.sidePanelHost) : null : details}
  </>
}

function RunDefaultWorktree({ selection, workflowVersionId }: {
  selection: SelectedRunState; workflowVersionId: string
}) {
  const scope = { ...selection.identity, runId: selection.identity.runId!, workflowVersionId,
    executionSemanticsVersion: 3 as const }
  const version = useRunVersionQuery(scope)
  if (!selection.isCurrent(selection.generation)) return null
  if (version.isError) return <p className="saved-workflow-worktree is-compact" role="status">Worktree: <em>unavailable</em></p>
  if (!version.data) return <p className="saved-workflow-worktree is-compact" role="status">Worktree: <span>Loading…</span></p>
  return <SavedWorkflowWorktree compact workspaceId={scope.workspaceId} value={version.data.version.definition.defaultWorktree} />
}

function SelectedRunComputers({ selection, nodes }: { selection: SelectedRunState; nodes: readonly RunBoardNodeSnapshot[] }) {
  const [open, setOpen] = useState(false)
  return <details className="run-board-computers" open={open} onToggle={(event) => setOpen(event.currentTarget.open)}>
    <summary>Computers</summary>
    {open ? nodes.map((node) => <section key={node.id} aria-label={`Computer evidence for ${node.name}`}>
      <h3>{node.name}</h3><SelectedNodePlacement selection={selection} nodeId={node.id} />
    </section>) : null}
  </details>
}

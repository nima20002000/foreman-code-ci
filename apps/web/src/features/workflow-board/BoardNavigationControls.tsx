import { useQuery } from '@tanstack/react-query'
import { Button, Icon, IconButton, Toolbar } from '../../shared/ui/nocturne'
import { RunsSelector, type useSelectedRun } from '../runs-selector'
import { ScheduleClockButton } from '../schedules'
import { WorkflowFilesButton } from '../workflow-files'
import { nextDraftApi } from '../graph'
import { boardDraftContextKey, useBoardSelection } from '../board-core'
import { useBrowserSidebar } from './useBrowserSidebar'
import { KanbanButton } from './kanban/KanbanButton'

export function BoardNavigationControls({ workspaceId, workflowId, selection, runsLabel }: {
  workspaceId: string; workflowId: string; selection: ReturnType<typeof useSelectedRun>; runsLabel?: string
}) {
  const board = useBoardSelection()
  const browsers = useBrowserSidebar(workspaceId, workflowId)
  const saved = useQuery({ queryKey: boardDraftContextKey(workspaceId, workflowId),
    queryFn: ({ signal }) => nextDraftApi.context(workspaceId, workflowId, { signal }), staleTime: 3000 })
  return <Toolbar label="Board controls">
    {/* A live Run painted on this Board needs no page to show it: Running is only a status here. */}
    {board?.liveRunId && selection.identity.runId === null ? board.liveRunId === board.paintedRunId
      ? <span role="status" className="board-live-run"><span className="board-live-run-dot" aria-hidden="true" />Running</span>
      : <Button size="sm" variant="ghost" className="board-live-run"
        title="A Run of an earlier saved version is running. Show it." onClick={() => void selection.selectRun(board.liveRunId!)}>
        <span className="board-live-run-dot" aria-hidden="true" />Running</Button> : null}
    <RunsSelector selection={selection} triggerLabel={runsLabel} />
    <ScheduleClockButton workspaceId={workspaceId} workflowId={workflowId} isSaved={Boolean(saved.data?.draft.baseWorkflowVersionId)} />
    <WorkflowFilesButton workspaceId={workspaceId} workflowId={workflowId} />
    <IconButton label="Browsers" title="Agent browsers" size="sm" variant="ghost" aria-pressed={browsers.isOpen} onClick={browsers.toggle}>
      <Icon name="globe" size={16} /></IconButton>
    {/* The draft editor has its own Kanban toggle; a shown Run (which the Board follows while live) needs one too. */}
    {board?.run || selection.identity.runId !== null ? <KanbanButton workspaceId={workspaceId} workflowId={workflowId} /> : null}
  </Toolbar>
}

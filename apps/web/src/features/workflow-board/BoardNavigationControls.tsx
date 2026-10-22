import { useQuery } from '@tanstack/react-query'
import { Button, Icon, IconButton, Toolbar } from '../../shared/ui/nocturne'
import { RunsSelector, type useSelectedRun } from '../runs-selector'
import { ScheduleClockButton } from '../schedules'
import { WorkflowFilesButton } from '../workflow-files'
import { nextDraftApi } from '../graph/nextDraft/transport'
import { boardDraftContextKey } from './keys'
import { useWorkflowBoard } from './context'
import { useBrowserSidebar } from './useBrowserSidebar'

export function BoardNavigationControls({ workspaceId, workflowId, selection, runsLabel }: {
  workspaceId: string; workflowId: string; selection: ReturnType<typeof useSelectedRun>; runsLabel?: string
}) {
  const board = useWorkflowBoard()
  const browsers = useBrowserSidebar(workspaceId, workflowId)
  const saved = useQuery({ queryKey: boardDraftContextKey(workspaceId, workflowId),
    queryFn: ({ signal }) => nextDraftApi.context(workspaceId, workflowId, { signal }), staleTime: 3000 })
  return <Toolbar label="Board controls">
    {board?.liveRunId && selection.identity.runId === null ? <Button size="sm" variant="ghost" className="board-live-run"
      title="A Run of this workflow is running. Show it." onClick={() => void selection.selectRun(board.liveRunId!)}>
      <span className="board-live-run-dot" aria-hidden="true" />Running</Button> : null}
    <RunsSelector selection={selection} triggerLabel={runsLabel} />
    <ScheduleClockButton workspaceId={workspaceId} workflowId={workflowId} isSaved={Boolean(saved.data?.draft.baseWorkflowVersionId)} />
    <WorkflowFilesButton workspaceId={workspaceId} workflowId={workflowId} readOnly={Boolean(board?.run) || selection.identity.runId !== null} />
    <IconButton label="Browsers" title="Agent browsers" size="sm" variant="ghost" aria-pressed={browsers.isOpen} onClick={browsers.toggle}>
      <Icon name="globe" size={16} /></IconButton>
  </Toolbar>
}

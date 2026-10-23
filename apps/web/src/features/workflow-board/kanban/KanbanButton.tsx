import { Icon, IconButton } from '../../../shared/ui/nocturne'
import { errorMessage } from '../../memory-boards'
import { useKanbanDocked } from '../dock/boardObjects'
import { useKanbanLayout } from './kanbanLayout'
import './boardKanban.css'

/** Puts the workflow's memory board on the Board canvas as the Kanban object, or takes it off again.
 * Taking it off only hides it; its cards stay. */
export function KanbanButton({ workspaceId, workflowId }: { workspaceId: string; workflowId: string }) {
  const { layout, readError, retryRead, save, saveError } = useKanbanLayout(workspaceId, workflowId)
  const docked = useKanbanDocked({ workspaceId, workflowId })
  const shown = layout?.visible === true
  const unreadable = !layout && !!readError
  return <IconButton label="Kanban" className="board-kanban-toggle" aria-pressed={shown} disabled={!layout && !unreadable}
    title={unreadable ? `Kanban layout could not be loaded: ${errorMessage(readError)}. Click to retry.`
      : saveError ? `Kanban layout not saved: ${errorMessage(saveError)}` : shown ? 'Remove the Kanban from the Board' : 'Add the Kanban to the Board'}
    onClick={() => {
      if (!layout) { if (unreadable) void retryRead(); return }
      docked.restore(); save({ ...layout, visible: !shown })
    }}><Icon name="grid" size={16} /></IconButton>
}

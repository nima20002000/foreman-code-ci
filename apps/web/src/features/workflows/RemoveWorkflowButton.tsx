import { useState, type ReactNode } from 'react'
import { ConfirmDialog, Icon, IconButton } from '../../shared/ui/nocturne'
import { useWorkflowRemoval } from './useWorkflowRemoval'

export function RemoveWorkflowButton({ workspaceId, workflowId, name, revision, renderTrigger }: {
  workspaceId: string; workflowId: string; name: string; revision: number
  renderTrigger?: (open: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [baseRevision, setBaseRevision] = useState(revision)
  const { mutation, remove, unresolved } = useWorkflowRemoval({ workspaceId, workflowId,
    revision: baseRevision, onRemoved: () => setOpen(false) })
  const show = () => { if (!mutation.isPending && !unresolved) { setBaseRevision(revision); mutation.reset(); setOpen(true) } }
  return <>
    {renderTrigger ? renderTrigger(show) : <IconButton label={`Remove ${name}`} variant="ghost" size="sm"
      className="workflow-navigation-remove" disabled={mutation.isPending} onClick={show}>
      <Icon name="trash" size={14} />
    </IconButton>}
    <ConfirmDialog open={open} title={`Remove ${name}?`}
      description="It leaves this workspace. Run history stays. A workflow with active runs can’t be removed."
      dismissalReason={unresolved ? 'Removal is unconfirmed. Retry checks the original removal before you can close this dialog.' : undefined}
      pending={mutation.isPending} confirmLabel={unresolved ? 'Retry removal' : 'Remove workflow'}
      error={mutation.isError ? mutation.error.message : unresolved && !mutation.isPending
        ? 'It may already be removed. Retry to check.' : undefined}
      onOpenChange={(next) => { if (!next && !mutation.isPending && !unresolved) { setOpen(false); mutation.reset() } }}
      onConfirm={() => void remove()} />
  </>
}

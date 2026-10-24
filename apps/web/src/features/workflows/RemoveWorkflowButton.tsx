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
    revision: renderTrigger ? baseRevision : revision, onRemoved: () => setOpen(false) })
  return <>
    {renderTrigger ? renderTrigger(() => { if (!mutation.isPending && !unresolved) { setBaseRevision(revision); mutation.reset(); setOpen(true) } }) : <IconButton label={mutation.isError ? `Retry removing ${name}` : `Remove ${name}`} variant="ghost" size="sm"
      className="workflow-navigation-remove" disabled={mutation.isPending} onClick={() => void remove()}>
      <Icon name="trash" size={14} />
    </IconButton>}
    {renderTrigger ? <ConfirmDialog open={open} title={`Remove ${name}?`}
      description="It leaves this workspace. Run history stays. A workflow with active runs can’t be removed."
      pending={mutation.isPending} confirmLabel={unresolved ? 'Retry removal' : 'Remove workflow'}
      error={mutation.isError ? mutation.error.message : unresolved && !mutation.isPending
        ? 'It may already be removed. Retry to check.' : undefined}
      onOpenChange={(next) => { if (!next && !mutation.isPending && !unresolved) { setOpen(false); mutation.reset() } }}
      onConfirm={() => void remove()} /> : mutation.isError ? <p className="workflow-navigation-remove-error" role="alert">{mutation.error.message}</p> : null}
  </>
}

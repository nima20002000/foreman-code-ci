import { useRef, useState, type ReactNode } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { ManagedWorkspace, WorkspaceArchiveInput } from '@foreman-code/contracts/management'

import { CommandAttempt } from '../../shared/api/commandAttempt'
import { queryKeys, useArchiveManagedWorkspaceMutation } from '../../shared/api/query'
import { getManagedWorkspace } from '../../shared/api/client'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { ConfirmDialog, Icon, IconButton } from '../../shared/ui/nocturne'

export function RemoveWorkspaceButton({ workspaceId, name, revision, renderTrigger }: {
  workspaceId: string
  name: string
  revision: number
  renderTrigger?: (open: () => void) => ReactNode
}) {
  const [open, setOpen] = useState(false)
  const [baseRevision, setBaseRevision] = useState(revision)
  const mutation = useArchiveManagedWorkspaceMutation()
  const queryClient = useQueryClient()
  const navigate = useNavigate()
  const attempt = useRef(new CommandAttempt<Omit<WorkspaceArchiveInput, 'commandId'>>())
  const inFlight = useRef(false)
  const locked = mutation.isPending || attempt.current.unresolved
  const close = () => { if (!locked) { setOpen(false); mutation.reset() } }
  const refreshRevision = async () => {
    try {
      const fresh = await queryClient.fetchQuery({ queryKey: queryKeys.managedWorkspace(workspaceId), staleTime: 0,
        queryFn: ({ signal }) => getManagedWorkspace(workspaceId, { signal }) })
      setBaseRevision(fresh.revision)
    } catch { /* ignore: the original rejection stays on screen and the next attempt keeps the revision it had. */ }
  }
  const remove = async () => {
    if (inFlight.current) return
    inFlight.current = true
    const generation = sessionGeneration()
    try {
      await mutation.mutateAsync(attempt.current.input({ workspaceId, expectedRevision: baseRevision }))
      assertSession(generation)
      attempt.current.succeeded()
    } catch (error) {
      attempt.current.failed(error)
      // A definite rejection may be a revision conflict; the next confirmation then carries the current revision.
      if (!attempt.current.unresolved) await refreshRevision()
      return
    } finally { inFlight.current = false }
    setOpen(false)
    void queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkspaces })
    void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) })
    void navigate({ to: '/workspaces', replace: true })
  }

  const show = () => {
    // A guarded rename updates the cache before observers receive the confirmed revision.
    const confirmed = queryClient.getQueryData<ManagedWorkspace>(queryKeys.managedWorkspace(workspaceId))
    setBaseRevision(confirmed?.revision ?? revision)
    mutation.reset()
    setOpen(true)
  }
  return <>
    {renderTrigger ? renderTrigger(show) : <IconButton label="Remove workspace" variant="ghost" className="workspace-remove-button" onClick={show}><Icon name="trash" size={16} /></IconButton>}
    <ConfirmDialog open={open} onOpenChange={(value) => { if (!value) close() }}
      title={`Remove ${name}?`}
      description="It leaves the workspace list. Folders the app created are deleted; folders you picked are kept. Run history stays. A workspace with active runs can’t be removed."
      pending={mutation.isPending} confirmLabel={attempt.current.unresolved ? 'Retry removal' : 'Remove workspace'}
      error={mutation.isError ? mutation.error.message : attempt.current.unresolved && !mutation.isPending
        ? 'It may already be removed. Retry to check.' : undefined}
      onConfirm={() => void remove()} />
  </>
}

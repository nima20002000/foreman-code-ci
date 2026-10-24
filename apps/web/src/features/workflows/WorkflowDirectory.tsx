import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useStore } from 'zustand'
import { createResourceSelection } from '../../shared/ui/resourceSelection'
import { apiClient } from '../../shared/api/client'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { LoadMore } from '../../shared/ui/LoadMore'
import type { WorkflowBatchArchiveInput, WorkflowUpdateInput } from '@foreman-code/contracts/management'
import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query'

import {
  queryKeys, useWorkflowPages,
  useUpdateManagedWorkflowMutation,
} from '../../shared/api/query'
import {
  ActionMenu, Alert, Button, ConfirmDialog, EmptyState, ErrorState, PageHeader, TextField,
} from '../../shared/ui/nocturne'
import { ResourceActionsMenu, ResourceCard } from '../../shared/ui/ResourceCard'
import { useWorkflowRemoval } from './useWorkflowRemoval'
import { NewWorkflowAction } from './NewWorkflowAction'
import './workflows.css'
import '../../shared/ui/resourceDirectory.css'

function WorkflowCardActions({ workspaceId, workflowId, name, revision }: {
  workspaceId: string; workflowId: string; name: string; revision: number
}) {
  const client = useQueryClient()
  const update = useUpdateManagedWorkflowMutation()
  const removal = useWorkflowRemoval({ workspaceId, workflowId, revision })
  const attempt = useRef(new CommandAttempt<Omit<WorkflowUpdateInput, 'commandId'>>())
  const original = useRef<Omit<WorkflowUpdateInput, 'commandId'> | undefined>(undefined)
  const inFlight = useRef(false)
  const [open, setOpen] = useState(false)
  const [nextName, setNextName] = useState(name)
  const [nameError, setNameError] = useState<string>()
  const nameInputRef = useRef<HTMLInputElement>(null)
  const pending = update.isPending || removal.mutation.isPending
  const uncertain = attempt.current.unresolved || removal.unresolved
  useEffect(() => { if (!open) setNextName(name) }, [name, open])

  const rename = async () => {
    if (inFlight.current || removal.unresolved) return
    const value = nextName.trim()
    if (!value) { setNameError('Enter a workflow name.'); nameInputRef.current?.focus(); return }
    inFlight.current = true
    const generation = sessionGeneration()
    try {
      if (!attempt.current.unresolved) original.current = { workspaceId, workflowId, expectedRevision: revision, name: value }
      await update.mutateAsync(attempt.current.input(original.current!))
      assertSession(generation)
      attempt.current.succeeded()
      setOpen(false)
      void client.invalidateQueries({ queryKey: queryKeys.managedWorkflows(workspaceId) })
    } catch (error) { attempt.current.failed(error) }
    finally { inFlight.current = false }
  }
  return (
    <ResourceActionsMenu name={name} open={open} onOpenChange={(next) => {
      if (!pending && !uncertain) setOpen(next)
    }}>
      <form className="resource-card-menu-rename" onSubmit={(event) => { event.preventDefault(); void rename() }}>
        <TextField ref={nameInputRef} label="Name" value={nextName} error={nameError} disabled={pending || uncertain}
          onChange={(event) => { setNextName(event.target.value); setNameError(undefined) }} />
        <Button type="submit" disabled={pending || removal.unresolved || !update.isError && nextName.trim() === name}>
          {update.isPending ? 'Renaming…' : update.isError ? 'Retry rename' : 'Rename'}
        </Button>
      </form>
      {update.isError ? <Alert live tone="danger" title={update.error.message} /> : null}
      {attempt.current.unresolved && !update.isPending ? <p role="status">The rename may have worked. Retry to check.</p> : null}
      <Button variant="danger" disabled={pending || attempt.current.unresolved} onClick={() => void removal.remove()}>
        {removal.mutation.isPending ? 'Removing…' : removal.mutation.isError ? `Retry removing ${name}` : 'Remove workflow'}
      </Button>
      {removal.mutation.isError ? <Alert live tone="danger" title={removal.mutation.error.message} /> : null}
    </ResourceActionsMenu>
  )
}

export function WorkflowDirectory({ workspaceId, headingLevel = 1, hideHeading = false }: { workspaceId: string; headingLevel?: 1 | 2; hideHeading?: boolean }) {
  return <WorkflowDirectoryContent key={workspaceId} workspaceId={workspaceId} headingLevel={headingLevel} hideHeading={hideHeading} />
}

function WorkflowDirectoryContent({ workspaceId, headingLevel, hideHeading }: { workspaceId: string; headingLevel: 1 | 2; hideHeading: boolean }) {
  const queryClient = useQueryClient()
  const managedQuery = useWorkflowPages(workspaceId, true, 'directory')
  const [selectionStore] = useState(() => createResourceSelection())
  const selection = useStore(selectionStore)
  const count = Object.keys(selection.selected).length
  const attempt = useRef(new CommandAttempt<Omit<WorkflowBatchArchiveInput, 'commandId'>>())
  const inFlight = useRef(false)
  const selectRef = useRef<HTMLButtonElement>(null)
  const wasSelecting = useRef(false)
  useEffect(() => {
    if (wasSelecting.current && !selection.selecting) selectRef.current?.focus()
    wasSelecting.current = selection.selecting
  }, [selection.selecting])
  const batch = useMutation({
    mutationFn: (input: WorkflowBatchArchiveInput) => apiClient.archiveManagedWorkflowBatch(input),
    onError: (error) => attempt.current.failed(error),
  })
  const locked = batch.isPending || attempt.current.unresolved
  const managed = [...new Map((managedQuery.data?.pages.flatMap((page) => page.items) ?? [])
    .map((item) => [item.workflow.id, item])).values()]
  const closeConfirmation = () => { if (!locked) { selection.confirm(false); batch.reset() } }
  const deleteSelected = async () => {
    if (inFlight.current) return
    inFlight.current = true
    const generation = sessionGeneration()
    try {
      const result = await batch.mutateAsync(attempt.current.input({ workspaceId,
        workflows: Object.entries(selection.selected).map(([workflowId, expectedRevision]) => ({ workflowId, expectedRevision })),
      }))
      assertSession(generation)
      attempt.current.succeeded()
      const deleted = new Set(result.value.workflowIds)
      queryClient.setQueriesData<InfiniteData<Awaited<ReturnType<typeof apiClient.listManagedWorkflowPage>>>>(
        { queryKey: [...queryKeys.managedWorkflows(workspaceId), 'pages'] }, (current) => current ? {
          ...current, pages: current.pages.map((page) => ({ ...page, items: page.items.filter((item) => !deleted.has(item.workflow.id)) })),
        } : current,
      )
      selection.clear(`${result.value.workflowIds.length} ${result.value.workflowIds.length === 1 ? 'workflow' : 'workflows'} deleted.`)
      void queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkflows(workspaceId) })
      void queryClient.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) })
    } catch (error) { attempt.current.failed(error) }
    finally { inFlight.current = false }
  }
  const selectable = managed.slice(0, 100).map((item) => ({ id: item.workflow.id, revision: item.revision }))
  const allShownSelected = selectable.length > 0 && selectable.every((item) => item.id in selection.selected)
  const managedById = new Map(managed.map((item) => [item.workflow.id, item]))
  const workflows = managed.map((item) => item.workflow)
  const actions = workflows.length > 0 ? <div className="resource-directory-actions workflow-directory-controls" role="group" aria-label="Workflow actions">
    {!selection.selecting ? <>
      <NewWorkflowAction workspaceId={workspaceId} size="sm" />
      <Button ref={selectRef} variant="ghost" size="sm" onClick={selection.start}>Select workflows</Button>
    </> : <>
      <Button variant="danger" size="sm" disabled={!count || locked} onClick={() => selection.confirm(true)}>Delete selected{count ? ` (${count})` : ''}</Button>
      <ActionMenu label="Selection options" width={200} disabled={locked} items={[
        { id: 'select-shown', label: allShownSelected ? 'Clear selection' : managed.length > 100 ? 'Select first 100 shown' : 'Select all shown',
          disabled: !selectable.length, onSelect: () => allShownSelected ? selection.deselectAll() : selection.selectMany(selectable) },
        { id: 'cancel-selection', label: 'Cancel selection', onSelect: () => selection.clear() },
      ]} />
    </>}
  </div> : undefined

  return (
    <section className={`workflow-directory resource-directory${hideHeading ? ' workflow-directory--embedded' : ''}`} aria-label="Workflows">
      {hideHeading ? actions && <div className="workflow-directory-toolbar">{actions}</div> : <PageHeader
        title="Workflows"
        headingLevel={headingLevel}
        actions={actions}
      />}

      {selection.notice ? <p role="status">{selection.notice}</p> : null}
      {workflows.length > 0 ? (
        <ul className="workflow-card-list resource-card-list" data-testid="workflow-card-list">
          {workflows.map((workflow) => (
            <li
              data-testid={`workflow-card-${workflow.id}`}
              key={workflow.id}
            >
              <ResourceCard name={workflow.name} icon="workflow" className="workflow-row"
                selection={selection.selecting ? {
                  'aria-label': `Select ${workflow.name}`, checked: workflow.id in selection.selected,
                  disabled: locked || (count >= 100 && !(workflow.id in selection.selected)),
                  onChange: () => selection.toggle(workflow.id, managedById.get(workflow.id)!.revision),
                } : undefined}
                open={<Link
                  to="/workspaces/$workspaceId"
                  params={{ workspaceId }}
                  search={{ workflowId: workflow.id }}
                />}
                actions={<WorkflowCardActions workspaceId={workspaceId} workflowId={workflow.id}
                  name={workflow.name} revision={managedById.get(workflow.id)!.revision}
                />}>
                <span className="workflow-row-status" data-state={managedById.get(workflow.id)?.currentVersionId ? 'saved' : 'draft'}>
                  {managedById.get(workflow.id)?.currentVersionId ? 'Saved' : 'Draft'}
                </span>
              </ResourceCard>
            </li>
          ))}
        </ul>
      ) : managedQuery.isPending ? (
        <ul className="workflow-card-list resource-card-list" aria-busy="true" aria-label="Loading workflows">
          {[0, 1, 2].map((index) => <li key={index} className="workflow-row-skeleton" />)}
        </ul>
      ) : managedQuery.isError ? (
        <ErrorState title="Workflows unavailable" description="The workflow list could not be loaded." onRetry={() => void managedQuery.refetch()} />
      ) : (
        <div className="workflow-directory-empty" data-testid="workflow-directory-empty">
          <EmptyState
            icon="workflow"
            title="No workflows yet"
            action={<NewWorkflowAction workspaceId={workspaceId} />}
          />
        </div>
      )}
      <LoadMore loadAll label="workflows" query={managedQuery} />
      <ConfirmDialog open={selection.confirming} onOpenChange={(open) => { if (!open) closeConfirmation() }}
        title={`Delete ${count} ${count === 1 ? 'workflow' : 'workflows'}?`}
        description="They leave this workspace. Saved versions and run history stay. Workflows with active runs can’t be deleted."
        pending={batch.isPending} confirmLabel={attempt.current.unresolved ? 'Retry' : 'Delete'}
        error={batch.isError ? batch.error.message : attempt.current.unresolved && !batch.isPending ? 'It may already be done. Retry to check.' : undefined}
        onConfirm={() => void deleteSelected()} />
    </section>
  )
}

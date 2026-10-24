import { useEffect, useRef, useState } from 'react'
import { Link } from '@tanstack/react-router'
import { useStore } from 'zustand'
import { createResourceSelection } from '../../shared/ui/resourceSelection'
import { apiClient } from '../../shared/api/client'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { LoadMore } from '../../shared/ui/LoadMore'
import type { WorkflowBatchArchiveInput } from '@foreman-code/contracts/management'
import { useMutation, useQueryClient, type InfiniteData } from '@tanstack/react-query'

import {
  queryKeys, useArchiveManagedWorkflowMutation, useWorkflowPages,
  useUpdateManagedWorkflowMutation,
} from '../../shared/api/query'
import {
  ActionMenu, Button, ConfirmDialog, EmptyState, ErrorState, PageHeader, TextField,
} from '../../shared/ui/nocturne'
import { ResourceActionsMenu, ResourceCard } from '../../shared/ui/ResourceCard'
import { NewWorkflowAction } from './NewWorkflowAction'
import './workflows.css'
import '../../shared/ui/resourceDirectory.css'

function WorkflowCardActions({ name, onRename, onRemove }: {
  name: string
  onRename: (name: string) => void
  onRemove: () => void
}) {
  const [open, setOpen] = useState(false)
  const [nextName, setNextName] = useState(name)
  const [nameError, setNameError] = useState<string>()
  const nameInputRef = useRef<HTMLInputElement>(null)

  useEffect(() => setNextName(name), [name])

  return (
    <ResourceActionsMenu name={name} open={open} onOpenChange={setOpen}>
      <form className="resource-card-menu-rename" onSubmit={(event) => {
        event.preventDefault()
        const value = nextName.trim()
        if (!value) {
          setNameError('Enter a workflow name.')
          nameInputRef.current?.focus()
          return
        }
        onRename(value)
        setOpen(false)
      }}>
        <TextField
          ref={nameInputRef}
          label="Name"
          value={nextName}
          error={nameError}
          onChange={(event) => {
            setNextName(event.target.value)
            if (nameError) setNameError(undefined)
          }}
        />
        <Button type="submit" disabled={nextName.trim() === name}>Rename</Button>
      </form>
      <Button variant="danger" onClick={onRemove}>Remove workflow</Button>
    </ResourceActionsMenu>
  )
}

export function WorkflowDirectory({ workspaceId, headingLevel = 1, hideHeading = false }: { workspaceId: string; headingLevel?: 1 | 2; hideHeading?: boolean }) {
  return <WorkflowDirectoryContent key={workspaceId} workspaceId={workspaceId} headingLevel={headingLevel} hideHeading={hideHeading} />
}

function WorkflowDirectoryContent({ workspaceId, headingLevel, hideHeading }: { workspaceId: string; headingLevel: 1 | 2; hideHeading: boolean }) {
  const queryClient = useQueryClient()
  const managedQuery = useWorkflowPages(workspaceId, true, 'directory')
  const updateWorkflow = useUpdateManagedWorkflowMutation()
  const archiveWorkflow = useArchiveManagedWorkflowMutation()
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
                actions={<WorkflowCardActions
                  name={workflow.name}
                  onRename={(name) => {
                    const item = managedById.get(workflow.id)
                    if (!item) return
                    updateWorkflow.mutate({ workspaceId, workflowId: workflow.id, expectedRevision: item.revision, commandId: crypto.randomUUID(), name }, {
                      onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkflows(workspaceId) }),
                    })
                  }}
                  onRemove={() => {
                    const item = managedById.get(workflow.id)
                    if (!item) return
                    archiveWorkflow.mutate({ workspaceId, workflowId: workflow.id, expectedRevision: item.revision, commandId: crypto.randomUUID() }, {
                      onSuccess: () => void queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkflows(workspaceId) }),
                    })
                  }}
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

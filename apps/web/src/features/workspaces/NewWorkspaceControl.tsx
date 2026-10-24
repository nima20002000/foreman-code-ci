import { useCallback, useEffect, useRef, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { useQueryClient } from '@tanstack/react-query'
import type { WorkspaceCreateInput } from '@foreman-code/contracts/management'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { errorMessage } from '../../shared/errorMessage'
import { CommandAttempt } from '../../shared/api/commandAttempt'
import { assertSession, sessionGeneration } from '../../shared/api/sessionBoundary'
import { queryKeys, useCreateManagedWorkspaceMutation } from '../../shared/api/query'
import { useWorkspaceCreationDefaultsQuery } from '../../shared/api/settingsExperience'
import { Button, Dialog, Icon, TextField } from '../../shared/ui/nocturne'
import { WorkspaceFolderPicker } from '../settings'

/** The always-visible, server-backed create entry point for the workspace list. */
export function NewWorkspaceControl() {
  const [creating, setCreating] = useState(false)
  const [name, setName] = useState('')
  const [parentPath, setParentPath] = useState('')
  const touched = useRef({ name: false, parentPath: false, defaultsApplied: false })
  const defaults = useWorkspaceCreationDefaultsQuery(creating)
  const [nameError, setNameError] = useState<string>()
  const triggerRef = useRef<HTMLButtonElement>(null)
  const nameInputRef = useRef<HTMLInputElement>(null)
  const navigate = useNavigate()
  const queryClient = useQueryClient()
  const createManagedWorkspace = useCreateManagedWorkspaceMutation()
  const inFlight = useRef(false)
  const attempt = useRef(new CommandAttempt<Omit<WorkspaceCreateInput, 'commandId'>>())
  const uncertain = attempt.current.unresolved && !createManagedWorkspace.isPending

  const closeCreateDialog = useCallback(() => {
    if (inFlight.current || attempt.current.unresolved) return
    setCreating(false)
    setName('')
    setParentPath('')
    touched.current = { name: false, parentPath: false, defaultsApplied: false }
    setNameError(undefined)
    window.setTimeout(() => triggerRef.current?.focus(), 0)
  }, [])

  useEffect(() => {
    if (!creating || touched.current.defaultsApplied || attempt.current.unresolved) return
    const template = defaults.data
    if (!template) return
    touched.current.defaultsApplied = true
    if (!touched.current.name) setName(template.suggestedName)
    if (!touched.current.parentPath) setParentPath(template.parentPath ?? '')
  }, [creating, defaults.data])

  useEffect(() => {
    if (creating && name && !touched.current.name && document.activeElement === nameInputRef.current) {
      nameInputRef.current?.select()
    }
  }, [creating, name])


  const createNewWorkspace = async () => {
    if (inFlight.current || (defaults.isPending && !attempt.current.unresolved)) return
    const trimmedName = name.trim()
    if (!trimmedName) { setNameError('Enter a workspace name.'); nameInputRef.current?.focus(); return }
    if (!parentPath) { setNameError('Choose a location for the project folder.'); return }
    inFlight.current = true
    const generation = sessionGeneration()
    setNameError(undefined)
    try {
      const workspace = (await createManagedWorkspace.mutateAsync(
        attempt.current.input({ ...(touched.current.name ? { name: trimmedName } : {}), parentPath }),
      )).value.workspace
      assertSession(generation)
      attempt.current.succeeded()
      void queryClient.invalidateQueries({ queryKey: queryKeys.managedWorkspaces })
        .catch(() => { /* ignore: the workspace was created; the list refreshes on its next query. */ })
      inFlight.current = false
      closeCreateDialog()
      void navigate({ to: '/workspaces/$workspaceId/settings', params: { workspaceId: workspace.id } })
    } catch (error) {
      attempt.current.failed(error)
      if (sessionGeneration() === generation) setNameError(errorMessage(error, 'The workspace could not be created.'))
    } finally { inFlight.current = false }
  }

  useUnsavedChanges({
    scope: 'surface', label: 'New workspace',
    dirty: creating && (touched.current.name || touched.current.parentPath),
    busy: createManagedWorkspace.isPending,
    uncertain,
    saveDisabled: !name.trim() || !parentPath.trim() || (defaults.isPending && !uncertain),
    error: nameError,
    save: createNewWorkspace,
    discard: closeCreateDialog,
  })

  return (
    <>
      <Button
        ref={triggerRef}
        variant="ghost"
        className="workspace-navigation-add"
        aria-label="New workspace"
        title="New workspace"
        aria-haspopup="dialog"
        aria-expanded={creating}
        leading={<Icon name="plus" size={15} />}
        onClick={() => setCreating(true)}
      >
        <span className="nav-item-label">New workspace</span>
      </Button>

      <Dialog
        open={creating}
        onOpenChange={(open) => { if (!open) closeCreateDialog() }}
        title="New workspace"
        closeLabel="Close new workspace"
        busy={createManagedWorkspace.isPending}
        initialFocusRef={nameInputRef}
        size="sm"
        footer={<>
          <Button onClick={closeCreateDialog}>Cancel</Button>
          <Button
            variant="primary"
            onClick={() => void createNewWorkspace()}
            disabled={createManagedWorkspace.isPending || (defaults.isPending && !uncertain)}
          >
            Create workspace
          </Button>
        </>}
      >
        <div className="n-stack">
          <TextField
            ref={nameInputRef}
            id="new-workspace-name"
            label="Name"
            disabled={createManagedWorkspace.isPending || uncertain}
            value={name}
            onFocus={(event) => { if (!touched.current.name) event.currentTarget.select() }}
            onChange={(event) => {
              touched.current.name = true
              setName(event.target.value)
              if (nameError) setNameError(undefined)
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault()
                void createNewWorkspace()
              }
            }}
            aria-invalid={nameError ? true : undefined}
            aria-describedby={nameError ? 'new-workspace-name-error' : undefined}
          />
          <WorkspaceFolderPicker value={parentPath} label="Location" disabled={createManagedWorkspace.isPending || uncertain} onSelect={(path) => {
            touched.current.parentPath = true; setParentPath(path)
          }} />
          {defaults.isPending ? <p role="status" className="n-field-hint">Loading the default location…</p> : null}
          {defaults.isError ? <p role="status" className="n-field-hint">Couldn’t load the default location. <Button size="sm" variant="ghost" onClick={() => void defaults.refetch()}>Try again</Button></p> : null}
          {nameError ? (
            <p id="new-workspace-name-error" className="workspace-create-error" role="alert">
              {nameError}
            </p>
          ) : null}
          {uncertain ? <p role="status" className="n-field-hint">The last attempt may have worked. Create again to check; it won’t make a duplicate.</p> : null}
        </div>
      </Dialog>
    </>
  )
}


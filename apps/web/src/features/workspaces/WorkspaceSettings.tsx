import { useEffect, useState } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import type { ManagedWorkspace } from '@foreman-code/contracts/management'
import { queryKeys, useUpdateManagedWorkspaceMutation } from '../../shared/api/query'
import { useWorkspaceRepository } from '../../shared/api/workspaceGit'
import { errorMessage } from '../../shared/errorMessage'
import { WorkspaceExecutionLocationSettings } from '../settings'
import { RemoveWorkspaceButton } from './RemoveWorkspaceButton'
import { WorkspaceRepositoryForm } from './WorkspaceRepositoryForm'

type Tone = 'success' | 'warning' | 'danger' | 'muted'

function projectStatus(state: string | undefined, commit: string | undefined, unreadable: boolean): { label: string; tone: Tone } {
  if (unreadable) return { label: 'Status unavailable', tone: 'warning' }
  if (state === 'ready') return { label: commit ? `Ready at ${commit.slice(0, 7)}` : 'Ready', tone: 'success' }
  if (state === 'preparing') return { label: 'Preparing…', tone: 'warning' }
  if (state === 'failed' || state === 'conflict') return { label: 'Needs attention', tone: 'danger' }
  if (state === 'metadata-only') return { label: 'Not prepared', tone: 'warning' }
  return { label: 'No repository', tone: 'muted' }
}

/** The workspace at a glance: its name as the title, one strip of facts, and the repository editor on demand. */
export function WorkspaceSettings({ workspace }: { workspace: ManagedWorkspace }) {
  const { workspace: { id, name, repository }, revision } = workspace
  const project = useWorkspaceRepository(id)
  // A failed status read withdraws the last known status instead of showing it as current.
  const state = project.isError ? undefined : project.data?.state
  const status = projectStatus(state, project.isError ? undefined : project.data?.approvedSource?.manifest.git?.commit, project.isError)
  // The editor starts open while the repository still needs something from the user.
  const [editing, setEditing] = useState(!repository)
  const needsAction = project.isError || (state !== undefined && state !== 'ready' && state !== 'unconfigured')
  const open = editing || needsAction
  const slug = repository ? `${repository.owner}/${repository.name}` : undefined
  return <div className="ws-settings">
    <WorkspaceTitle workspaceId={id} name={name} revision={revision} />
    <dl className="ws-facts">
      <div className="ws-fact">
        <dt>Repository</dt>
        <dd><button type="button" className={`ws-fact-edit${slug ? '' : ' is-empty'}`} aria-expanded={open}
          onClick={() => setEditing(!editing)} title={slug}>{slug ?? 'Connect GitHub'}</button></dd>
      </div>
      <div className="ws-fact">
        <dt>Branch</dt>
        <dd>{repository?.defaultBranch ?? '—'}</dd>
      </div>
      <div className="ws-fact ws-fact--location">
        <dt>Runs on</dt>
        <dd><WorkspaceExecutionLocationSettings workspaceId={id} presentation="compact" /></dd>
      </div>
      <div className="ws-fact">
        <dt>Project</dt>
        <dd><span className="ws-status" data-tone={status.tone}>{status.label}</span></dd>
      </div>
    </dl>
    {open ? <div className="ws-editor">
      <WorkspaceRepositoryForm key={id} workspaceId={id} revision={revision} repository={repository} />
    </div> : null}
    <footer className="ws-settings-foot">
      <RemoveWorkspaceButton workspaceId={id} name={name} revision={revision}
        renderTrigger={(remove) => <button type="button" className="ws-remove" onClick={remove}>Remove workspace</button>} />
    </footer>
  </div>
}

function WorkspaceTitle({ workspaceId, name, revision }: { workspaceId: string; name: string; revision: number }) {
  const [value, setValue] = useState(name)
  const [error, setError] = useState<string>()
  const mutation = useUpdateManagedWorkspaceMutation()
  const client = useQueryClient()
  useEffect(() => setValue(name), [name])
  const save = async () => {
    const next = value.trim()
    if (!next) { setValue(name); return }
    if (next === name || mutation.isPending) return
    setError(undefined)
    try {
      const result = await mutation.mutateAsync({ workspaceId, commandId: crypto.randomUUID(), expectedRevision: revision, name: next })
      client.setQueryData(queryKeys.managedWorkspace(workspaceId), result.value)
      void client.invalidateQueries({ queryKey: queryKeys.managedWorkspaces })
      void client.invalidateQueries({ queryKey: queryKeys.workspaceDetails(workspaceId) })
    } catch (cause) {
      setError(errorMessage(cause, 'The workspace could not be renamed.'))
    }
  }
  return <div className="ws-title">
    {/* eslint-disable-next-line no-restricted-syntax -- the name is edited in place as the page title. */}
    <input className="ws-title-input" aria-label="Workspace name" value={value} maxLength={200} disabled={mutation.isPending}
      onChange={(event) => { setValue(event.target.value); setError(undefined) }}
      onBlur={() => void save()}
      onKeyDown={(event) => {
        if (event.key === 'Enter') event.currentTarget.blur()
        if (event.key === 'Escape') { setValue(name); setError(undefined) }
      }} />
    {error ? <p className="ws-error" role="alert">{error}</p> : null}
  </div>
}

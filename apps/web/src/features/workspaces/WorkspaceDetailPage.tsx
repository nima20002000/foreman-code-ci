import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useManagedWorkspaceQuery } from '../../shared/api/query'
import { useBlockingReadError } from '../../shared/api/readFailure'
import { Button, ErrorState, LoadingState, SettingRow, SettingsSection } from '../../shared/ui/nocturne'
import { WorkspaceSettingsHeader } from './WorkspaceSettingsHeader'
import { WorkspaceRepositoryForm } from './WorkspaceRepositoryForm'
import '../settings/settingsExperience.css'

export function WorkspaceDetailPage({ workspaceId, section, children }: {
  workspaceId: string; section: 'memory' | 'files' | 'workflows' | 'settings'; children?: ReactNode
}) {
  const workspace = useManagedWorkspaceQuery(workspaceId)
  const blocked = useBlockingReadError(workspace)
  const current = workspace.data?.workspace.id === workspaceId ? workspace.data : undefined
  const title = section === 'memory' ? 'Memory board' : section === 'files' ? 'Project files' : section === 'workflows' ? 'Workflows' : 'Settings'
  const unavailable = workspace.isError
    ? <ErrorState title="Workspace unavailable" description={workspace.error.message} onRetry={() => void workspace.refetch()} retrying={workspace.isFetching} />
    : <LoadingState label="Loading workspace…" rows={3} />
  // One frame for every state: the section navigation and the sections that only need the workspace id
  // never wait for the identity read, and nothing below the header remounts when it arrives.
  const settings = (actions: { rename(): void; remove(): void; chooseLocation(): void }) => <>
          {workspace.isError && unavailable}
          <div className="workspace-settings-sections" hidden={Boolean(blocked)}>
            <SettingsSection title="General">
              <SettingRow title="Name" description={current?.workspace.name}>
                <Button size="sm" onClick={actions.rename}>Rename</Button>
              </SettingRow>
              <SettingRow title="Location" description="Where this workspace's files live.">
                <Button size="sm" onClick={actions.chooseLocation}>Change</Button>
              </SettingRow>
            </SettingsSection>
            <SettingsSection title="Repository" description="Each agent gets its own branch and worktree of this repository.">
              {current && <WorkspaceRepositoryForm key={workspaceId} workspaceId={workspaceId}
                revision={current.revision} repository={current.workspace.repository} />}
            </SettingsSection>
            <SettingsSection title="Danger zone">
              <SettingRow title="Remove workspace" description="Removes it from Foreman.">
                <Button size="sm" variant="danger" onClick={actions.remove}>Remove</Button>
              </SettingRow>
            </SettingsSection>
          </div>
        </>
  const content = (actions: { rename(): void; remove(): void; chooseLocation(): void }) => <div className="settings-editor-layout workspace-detail-layout">
      <nav className="settings-editor-nav workspace-detail-nav" aria-label="Workspace sections">
        <Link to="/workspaces/$workspaceId/files" params={{ workspaceId }} aria-current={section === 'files' ? 'page' : undefined}>Project files</Link>
        <Link to="/workspaces/$workspaceId/workflows" params={{ workspaceId }} aria-current={section === 'workflows' ? 'page' : undefined}>Workflows</Link>
        <Link to="/workspaces/$workspaceId/settings" params={{ workspaceId }} aria-current={section === 'settings' ? 'page' : undefined}>Settings</Link>
      </nav>
      <div className={`settings-editor-content workspace-detail-content${section === 'settings' ? ' workspace-detail-content--settings' : ''}`}>
        {!current && workspace.isError ? unavailable : children ?? (current ? settings(actions) : unavailable)}
      </div>
    </div>
  return <div className="settings-page settings-experience workspace-detail-page">
    <WorkspaceSettingsHeader key={workspaceId} workspaceId={workspaceId} name={current?.workspace.name} revision={current?.revision}
      failed={workspace.isError} title={title} renderContent={content} />
  </div>
}

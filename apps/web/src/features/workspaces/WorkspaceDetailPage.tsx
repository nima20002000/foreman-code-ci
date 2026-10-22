import type { ReactNode } from 'react'
import { Link } from '@tanstack/react-router'
import { useManagedWorkspaceQuery } from '../../shared/api/query'
import { ErrorState, Skeleton } from '../../shared/ui/nocturne'
import { WorkspaceSettings } from './WorkspaceSettings'
import './workspacePage.css'

/** A workspace page: section tabs above the section. Settings are rendered here; other sections pass children. */
export function WorkspaceDetailPage({ workspaceId, section, children }: {
  workspaceId: string; section: 'memory' | 'files' | 'workflows' | 'settings'; children?: ReactNode
}) {
  const workspace = useManagedWorkspaceQuery(workspaceId)
  const current = workspace.data?.workspace.id === workspaceId ? workspace.data : undefined
  const tab = (name: typeof section) => name === section ? 'page' as const : undefined
  let body = children
  if (section === 'settings') body = current ? <WorkspaceSettings key={workspaceId} workspace={current} />
    : workspace.isError ? null : <Skeleton width="16rem" height="2.5rem" />
  return <div className="ws-page">
    <nav className="ws-tabs" aria-label="Workspace sections">
      <Link to="/workspaces/$workspaceId/files" params={{ workspaceId }} aria-current={tab('files')}>Project files</Link>
      <Link to="/workspaces/$workspaceId/workflows" params={{ workspaceId }} aria-current={tab('workflows')}>Workflows</Link>
      <Link to="/workspaces/$workspaceId/settings" params={{ workspaceId }} aria-current={tab('settings')}>Settings</Link>
    </nav>
    {!current && workspace.isError ? <ErrorState title="Workspace unavailable" description={workspace.error.message}
      onRetry={() => void workspace.refetch()} /> : body}
  </div>
}

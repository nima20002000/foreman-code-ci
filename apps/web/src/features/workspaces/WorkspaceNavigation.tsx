import {
  useEffect,
  useId,
  useMemo,
  type ReactNode,
} from 'react'
import { SidebarNavigationButton } from '../../shared/ui/SidebarNavigationButton'
import {
  ChevronDown,
  PanelsTopLeft,
  Workflow,
} from 'lucide-react'
import { LoadMore } from '../../shared/ui/LoadMore'
import type { ComponentProps } from 'react'
import type { Workspace } from '@foreman-code/contracts'

import { useManagedWorkspaceQuery, usePrefetchBoard } from '../../shared/api/query'
import { Button, Icon, IconButton } from '../../shared/ui/nocturne'
import { NewWorkspaceControl } from './NewWorkspaceControl'
import { usePresence } from '../../shared/ui/usePresence'
import { WorkflowNavigation } from '../workflows'
import { useNavigationUiStore } from './navigationUiStore'
import {
  WORKSPACES_ORDER_KEY,
  useNavigationOrderStore,
  workspaceSectionsOrderKey,
} from './navigationOrder'
import {
  useReorderableNavigation,
  type ReorderItemProps,
  type ReorderKeyboardProps,
} from './useReorderableNavigation'
import './workspaces.css'

export type WorkspaceSection =
  | 'memory'
  | 'agents'
  | 'workflows'
  | 'files'
  | 'tasks'
  | 'runs'
  | 'terminal'
  | 'settings'

export type GlobalNavigationSection = 'terminal' | 'settings'

export type WorkspaceNavigationEntry = Pick<Workspace, 'id' | 'name'>

export interface WorkspaceNavigationProps {
  workspaceId: string
  activeSection?: WorkspaceSection
  /** URL-owned workflow selection for the active workspace. */
  activeWorkflowId?: string
  /** Active top-level destination outside the workspace tree. */
  activeGlobalSection?: GlobalNavigationSection
  /**
   * Server-shaped workspace list. When omitted, the active workspace
   * projection from the workspace query is the only entry.
   */
  workspaces?: readonly WorkspaceNavigationEntry[]
  workspacePagination?: ComponentProps<typeof LoadMore>['query'] & {
    isPending?: boolean; isError?: boolean; refetch?: () => unknown
  }
  navigationCollapsed?: boolean
  /** The workspace directory is selected instead of a specific workspace. */
  workspaceOverviewActive?: boolean
  /** Route-supplied submenu content override for the active workspace. */
  workflowsContent?: ReactNode
}

const workspaceSections: readonly WorkspaceSection[] = [
  'workflows',
  'files',
  'tasks',
  'runs',
]

const workspaceSectionItems = [{ id: 'workflows', label: 'Workflows' }]

interface WorkspaceTreeItemProps {
  entry: WorkspaceNavigationEntry
  active: boolean
  expanded: boolean
  onActivate: () => void
  onToggle: () => void
  activeWorkflowId?: string
  navigationCollapsed: boolean
  workflowsContent?: ReactNode
  reorderItemProps?: ReorderItemProps
  reorderKeyboardProps?: ReorderKeyboardProps
}

function WorkspaceTreeItem({
  entry,
  active,
  expanded,
  onActivate,
  onToggle,
  activeWorkflowId,
  navigationCollapsed,
  workflowsContent,
  reorderItemProps,
  reorderKeyboardProps,
}: WorkspaceTreeItemProps) {
  const prefetch = usePrefetchBoard()
  const workflowsExpanded = useNavigationUiStore(
    (state) => state.expandedSections[entry.id]?.workflows ?? true,
  )
  const setSectionExpanded = useNavigationUiStore((state) => state.setSectionExpanded)
  const sectionsPresence = usePresence(expanded)
  const workflowsPresence = usePresence(workflowsExpanded)

  const idPrefix = useId().replaceAll(':', '')
  const sectionsId = `${idPrefix}-sections`
  const workflowsPanelId = `${idPrefix}-workflows`

  const sections = useReorderableNavigation(
    workspaceSectionsOrderKey(entry.id),
    workspaceSectionItems,
  )

  const renderSection = (section: WorkspaceSection) => {
    const reorderProps = sections.getItemProps(section)
    if (section === 'workflows') {
      return (
        <>
          <div className="nav-item-row" {...reorderProps}>
            <SidebarNavigationButton
              to="/workspaces/$workspaceId/workflows"
              params={{ workspaceId: entry.id }}
              activeOptions={{ exact: true }}
              onMouseEnter={() => prefetch.workflows(entry.id)}
              onFocus={() => prefetch.workflows(entry.id)}
              activeProps={{ className: 'nav-item-active', 'aria-current': 'page' }}
              className="nav-item"
              {...sections.getKeyboardProps(section)}
              aria-label={navigationCollapsed ? 'Workflows' : undefined}
              title="Workflows"
            >
              <span className="nav-item-primary">
                <Workflow aria-hidden="true" className="nav-item-icon" size={16} />
                <span className="nav-item-label">Workflows</span>
              </span>
            </SidebarNavigationButton>
            <IconButton
              className="nav-item-toggle"
              label={`${workflowsExpanded ? 'Collapse' : 'Expand'} workflows in ${entry.name}`}
              aria-expanded={workflowsExpanded}
              aria-controls={workflowsPanelId}
              onClick={() => setSectionExpanded(entry.id, 'workflows', !workflowsExpanded)}
              {...sections.getKeyboardProps(section)}
            >
              <ChevronDown aria-hidden="true" className="nav-item-chevron" size={14} />
            </IconButton>
          </div>
          {workflowsPresence.mounted ? (
            <div
              className={`workspace-navigation-panel nav-submenu-motion${workflowsPresence.exiting ? ' is-exiting' : ''}`}
              id={workflowsPanelId}
              aria-hidden={!workflowsExpanded}
              inert={!workflowsExpanded ? true : undefined}
            >
              {(active ? workflowsContent : undefined) ?? (
                <WorkflowNavigation
                  workspaceId={entry.id}
                  activeWorkflowId={active ? activeWorkflowId : undefined}
                />
              )}
            </div>
          ) : null}
        </>
      )
    }

    return null
  }

  return (
    <li>
      <div className="nav-item-row" {...reorderItemProps}>
        <SidebarNavigationButton
          to="/workspaces/$workspaceId/settings"
          params={{ workspaceId: entry.id }}
          search={{}}
          activeOptions={{ exact: true, includeSearch: false }}
          className={`nav-item nav-item-parent${active ? ' nav-item-active' : ''}`}
          aria-current={active ? 'location' : undefined}
          aria-label={navigationCollapsed ? entry.name : undefined}
          title={entry.name}
          data-testid={`workspace-entry-${entry.id}`}
          onClick={onActivate}
          onMouseEnter={() => prefetch.workspace(entry.id)}
          onFocus={() => prefetch.workspace(entry.id)}
          {...reorderKeyboardProps}
        >
          <span className="nav-item-primary">
            <PanelsTopLeft aria-hidden="true" className="nav-item-icon" size={16} />
            <span className="nav-item-label">{entry.name}</span>
          </span>
        </SidebarNavigationButton>
        <IconButton
          className="nav-item-toggle"
          label={`${expanded ? 'Collapse' : 'Expand'} ${entry.name}`}
          aria-expanded={expanded}
          aria-controls={sectionsId}
          onClick={onToggle}
          {...reorderKeyboardProps}
        >
          <ChevronDown aria-hidden="true" className="nav-item-chevron" size={14} />
        </IconButton>
      </div>

      {sectionsPresence.mounted ? (
        <ul
          className={`nav-submenu workspace-entry-sections nav-submenu-motion${sectionsPresence.exiting ? ' is-exiting' : ''}`}
          id={sectionsId}
          aria-hidden={!expanded}
          inert={!expanded ? true : undefined}
          {...sections.containerProps}
        >
          {sections.orderedIds.map((section) => {
            const sectionId = section as WorkspaceSection
            return (
              <li key={sectionId}>
                {renderSection(sectionId)}
              </li>
            )
          })}
          {(['files', 'settings'] as const).map((section) => <li key={section}>
            <SidebarNavigationButton
              to={section === 'files' ? '/workspaces/$workspaceId/files' : '/workspaces/$workspaceId/settings'}
              params={{ workspaceId: entry.id }} search={{}}
              activeOptions={{ exact: true }} activeProps={{ className: 'nav-item-active', 'aria-current': 'page' }}
              className="nav-item" aria-label={section === 'settings' ? 'Workspace settings' : 'Project files'}
              title={section === 'settings' ? 'Workspace settings' : 'Project files'}>
              <span className="nav-item-primary">
                <Icon name={section === 'files' ? 'folder' : 'settings'} className="nav-item-icon" size={16} />
                <span className="nav-item-label">{section === 'files' ? 'Project files' : 'Settings'}</span>
              </span>
            </SidebarNavigationButton>
          </li>)}
        </ul>
      ) : null}
    </li>
  )
}

/**
 * The workspace-first sidebar hierarchy. Workspaces is the collapsible parent,
 * every workspace entry opens its settings and expands into Workflows.
 * App Settings lives in the shell footer.
 * The Agents destination remains routed but is temporarily hidden here.
 * Workspace and workflow lists are server-shaped query projections; selection
 * stays in the URL through router links.
 */
export function WorkspaceNavigation({
  workspaceId,
  activeSection = 'workflows',
  activeWorkflowId,
  activeGlobalSection,
  workspaces,
  navigationCollapsed = false,
  workspaceOverviewActive = false,
  workflowsContent,
  workspacePagination,
}: WorkspaceNavigationProps) {
  // Global and overview pages pass a placeholder id; only a real workspace page reads its details.
  const detailsQuery = useManagedWorkspaceQuery(workspaceId, !activeGlobalSection && !workspaceOverviewActive)
  const rememberWorkspace = useNavigationUiStore((state) => state.rememberWorkspace)
  const workspacesExpanded = useNavigationUiStore((state) => state.workspacesExpanded)
  const setWorkspacesExpanded = useNavigationUiStore((state) => state.setWorkspacesExpanded)
  const expandedWorkspaceIds = useNavigationUiStore((state) => state.expandedWorkspaceIds)
  const setWorkspaceExpanded = useNavigationUiStore((state) => state.setWorkspaceExpanded)
  const workspacesPresence = usePresence(workspacesExpanded)

  useEffect(() => {
    if (!activeGlobalSection && !workspaceOverviewActive && detailsQuery.data?.workspace) {
      rememberWorkspace(workspaceId)
    }
  }, [activeGlobalSection, detailsQuery.data?.workspace, rememberWorkspace, workspaceId, workspaceOverviewActive])

  const entries = useMemo<readonly WorkspaceNavigationEntry[]>(
    () => {
      const next = [...(workspaces ?? [])]
      const known = new Set(next.map((entry) => entry.id))
      if (!workspaceOverviewActive && detailsQuery.data?.workspace && !known.has(workspaceId)) {
        next.unshift({
          id: workspaceId,
          name: detailsQuery.data.workspace.name,
        })
      }
      return next
    },
    [detailsQuery.data?.workspace, workspaces, workspaceId, workspaceOverviewActive],
  )

  const entryItems = useMemo(
    () => entries.map((entry) => ({ id: entry.id, label: entry.name })),
    [entries],
  )
  const entryById = useMemo(
    () => new Map(entries.map((entry) => [entry.id, entry])),
    [entries],
  )
  const entriesReorder = useReorderableNavigation(WORKSPACES_ORDER_KEY, entryItems)
  const announcement = useNavigationOrderStore((state) => state.announcement)

  const toggleWorkspace = (id: string) => {
    setWorkspaceExpanded(id, !(expandedWorkspaceIds[id] ?? id === workspaceId))
  }

  const workspacesActive = workspaceOverviewActive || (
    !activeGlobalSection && workspaceSections.includes(activeSection)
  )

  return (
    <>
      <ul className="workspace-navigation" data-testid="workspace-navigation">
        <li>
          <div className="nav-item-row">
            <SidebarNavigationButton
              to="/workspaces"
              activeOptions={{ exact: true }}
              className={`nav-item nav-item-parent${workspacesActive ? ' nav-item-active' : ''}`}
              aria-label={navigationCollapsed ? 'Workspaces' : undefined}
              title="Workspaces"
            >
              <span className="nav-item-primary">
                <PanelsTopLeft aria-hidden="true" className="nav-item-icon" size={16} />
                <span className="nav-item-label">Workspaces</span>
              </span>
            </SidebarNavigationButton>
            <IconButton
              className="nav-item-toggle"
              label="Workspaces"
              aria-expanded={workspacesExpanded}
              aria-controls="workspace-entries"
              onClick={() => setWorkspacesExpanded(!workspacesExpanded)}
            >
              <ChevronDown aria-hidden="true" className="nav-item-chevron" size={14} />
            </IconButton>
          </div>

          {workspacesPresence.mounted ? (
            <ul
              className={`nav-submenu workspace-navigation-list nav-submenu-motion${workspacesPresence.exiting ? ' is-exiting' : ''}`}
              id="workspace-entries"
              aria-hidden={!workspacesExpanded}
              inert={!workspacesExpanded ? true : undefined}
              {...entriesReorder.containerProps}
            >
              {entriesReorder.orderedIds.map((entryId) => {
                const entry = entryById.get(entryId)
                if (!entry) return null
                return (
                  <WorkspaceTreeItem
                    key={entry.id}
                    entry={entry}
                    active={entry.id === workspaceId && !activeGlobalSection && !workspaceOverviewActive}
                    expanded={expandedWorkspaceIds[entry.id] ?? (
                      entry.id === workspaceId && !activeGlobalSection && !workspaceOverviewActive
                    )}
                    onActivate={() => rememberWorkspace(entry.id)}
                    onToggle={() => toggleWorkspace(entry.id)}
                    activeWorkflowId={activeWorkflowId}
                    navigationCollapsed={navigationCollapsed}
                    workflowsContent={workflowsContent}
                    reorderItemProps={entriesReorder.getItemProps(entry.id)}
                    reorderKeyboardProps={entriesReorder.getKeyboardProps(entry.id)}
                  />
                )
              })}
              {workspacePagination?.isPending ? <li role="status">Loading workspaces…</li> : null}
              {workspacePagination?.isError && !workspacePagination.isFetchNextPageError ? <li role="alert">
                Workspaces unavailable
                <Button size="sm" onClick={() => void workspacePagination.refetch?.()}>Retry workspaces</Button>
              </li> : null}
              {workspacePagination ? <li><LoadMore label="workspaces" query={workspacePagination} /></li> : null}
              <li>
                <NewWorkspaceControl />
              </li>
            </ul>
          ) : null}
        </li>
      </ul>

      <p
        key={announcement?.nonce ?? 0}
        className="visually-hidden"
        data-testid="navigation-reorder-announcement"
        role="status"
        aria-live="polite"
      >
        {announcement?.message ?? ''}
      </p>
    </>
  )
}

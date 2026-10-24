import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefCallback, type RefObject } from 'react'
import type { BoardSidePanel } from '@foreman-code/contracts/current'
import type { HierarchyReport } from '@foreman-code/contracts'
import { Button, Icon, IconButton } from '../../shared/ui/nocturne'
import { placeBeside } from '../../shared/ui/floatingWindow'
import { useManagedWorkflowQuery } from '../../shared/api/query'
import { useSidePanelScroll } from './sidePanelPresentation'
import type { CollaborationFieldSlots } from '../board-core'
import type { WorkflowExecutionChatSlotSelection } from '../workflow-hierarchy'

export interface WorkflowCollaborationSlots extends CollaborationFieldSlots {
  /** URL-owned selection. F3 resolves it through the canonical delivery target service. */
  executionChat?(selection: WorkflowExecutionChatSlotSelection): ReactNode
  browser?(selection: Extract<BoardSidePanel, { kind: 'browser' }> & {
    workspaceId: string; workflowId: string; runId?: string; workflowVersionId?: string
  }): ReactNode
  /** The right-hand sidebar of live Agent browsers in the selected Run, one tab per Agent. */
  browserSidebar?(scope: { workspaceId: string; workflowId: string; runId?: string; workflowVersionId?: string }): ReactNode
  /** B retains exact release identity and minimal reconciliation after its body unmounts. */
  beforeBrowserHide?(): void | Promise<void>
  browserRecovery?(): ReactNode
  overview?(): ReactNode
  reportCard?(cardId: string, report: HierarchyReport): void
}

export interface WorkflowSidePanelProps {
  scope: string
  workspaceId: string
  workflowId: string
  runId?: string
  workflowVersionId?: string
  opener: RefObject<HTMLElement | null>
  selection: BoardSidePanel
  agentSelection?: Extract<BoardSidePanel, { kind: 'agent' }>
  onSelect(selection: BoardSidePanel): void
  onSelectTarget: WorkflowExecutionChatSlotSelection['onSelectTarget']
  onSelectRun: WorkflowExecutionChatSlotSelection['onSelectRun']
  bodyRef: RefCallback<HTMLDivElement>
  headerSlotRef?: RefCallback<HTMLDivElement>
  footerSlotRef?: RefCallback<HTMLDivElement>
  modalOpen: boolean
  slots?: WorkflowCollaborationSlots
}

const tabs = [['chat', 'Chat'], ['settings', 'Settings'], ['details', 'Details']] as const

/** Beside the node that opened it; below the toolbar when a toolbar button opened it, so the toolbar stays usable. */
function placeNear(width: number, height: number, opener: HTMLElement | null) {
  const rect = opener?.getBoundingClientRect()
  const gap = 8
  if (!rect) {
    // Reopened from a link (no opener): top right, but below the Board toolbar so it never covers it.
    // The toolbar may not have rendered yet, so fall back to the views bar plus one toolbar row.
    const bar = [...document.querySelectorAll<HTMLElement>('.unified-workflow-board [role="toolbar"]')]
      .find(element => element.offsetParent !== null)?.getBoundingClientRect()
    const views = document.querySelector('.workflow-collaboration-toolbar')?.getBoundingClientRect()
    const below = bar ? bar.bottom : views ? views.bottom + 56 : undefined
    if (below !== undefined) return { left: Math.max(gap, window.innerWidth - width - 24),
      top: Math.max(gap, Math.min(below + gap, window.innerHeight - height - gap)) }
  }
  if (!rect || !opener?.closest('.board-topbar, [role="toolbar"]')) return placeBeside(width, height, rect)
  return { left: Math.max(gap, Math.min(rect.right - width, window.innerWidth - width - gap)),
    top: Math.max(gap, Math.min(rect.bottom + gap, window.innerHeight - height - gap)) }
}

/** Floating, draggable, resizable window opened next to the selected node. Only the selected body mounts;
 * the portal host preserves existing conversation/store ownership. */
export function WorkflowSidePanel({ scope, workspaceId, workflowId, runId, workflowVersionId,
  opener, selection, agentSelection, onSelect, onSelectTarget, onSelectRun, bodyRef, headerSlotRef, footerSlotRef, modalOpen, slots }: WorkflowSidePanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  const workflow = useManagedWorkflowQuery(workspaceId, workflowId)
  const heldFocus = useRef(false)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const attach = useCallback((element: HTMLDivElement | null) => { setHost(element); bodyRef(element) }, [bodyRef])
  useSidePanelScroll(host, JSON.stringify([scope, runId, selection]), modalOpen)
  const active = selection.kind !== 'none'
  // Open next to the node that opened it; keep the user's position while it stays open.
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!active || modalOpen || !panel) return
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true })
    if (panel.dataset.placed) return
    const { left, top } = placeNear(panel.offsetWidth, panel.offsetHeight, opener.current)
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
    panel.dataset.placed = 'true'
  }, [active, modalOpen, opener])
  useEffect(() => { if (!active) delete panelRef.current?.dataset.placed }, [active])
  const drag = (event: ReactPointerEvent<HTMLElement>) => {
    const panel = panelRef.current
    if (!panel || event.button !== 0 || (event.target as Element).closest('button')) return
    const startX = event.clientX - panel.offsetLeft, startY = event.clientY - panel.offsetTop
    const move = (e: PointerEvent) => {
      panel.style.left = `${Math.max(0, Math.min(e.clientX - startX, window.innerWidth - 80))}px`
      panel.style.top = `${Math.max(0, Math.min(e.clientY - startY, window.innerHeight - 40))}px`
    }
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    event.preventDefault()
  }
  const resize = (event: ReactPointerEvent<HTMLElement>) => {
    const panel = panelRef.current
    const edge = event.currentTarget.dataset.edge ?? ''
    if (!panel || event.button !== 0) return
    const start = { x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop,
      width: panel.offsetWidth, height: panel.offsetHeight }
    const style = getComputedStyle(panel)
    const minW = parseFloat(style.minWidth) || 280, minH = parseFloat(style.minHeight) || 220
    const move = (e: PointerEvent) => {
      const dx = e.clientX - start.x, dy = e.clientY - start.y
      if (edge.includes('e')) panel.style.width = `${Math.max(minW, start.width + dx)}px`
      if (edge.includes('s')) panel.style.height = `${Math.max(minH, start.height + dy)}px`
      if (edge.includes('w')) {
        const width = Math.max(minW, start.width - dx)
        panel.style.width = `${width}px`
        panel.style.left = `${start.left + start.width - width}px`
      }
      if (edge.includes('n')) {
        const height = Math.max(minH, start.height - dy)
        panel.style.height = `${height}px`
        panel.style.top = `${start.top + start.height - height}px`
      }
    }
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    event.preventDefault()
    event.stopPropagation()
  }
  useEffect(() => {
    const panel = panelRef.current
    if (!active || modalOpen || !panel) {
      heldFocus.current = false
      return
    }
    if (document.activeElement && document.activeElement !== document.body) {
      heldFocus.current = panel.contains(document.activeElement)
    }
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const focused = document.activeElement
      const inside = panel.contains(focused)
      const orphaned = heldFocus.current && (!focused || focused === document.body)
      if (!(inside || orphaned) || document.querySelector('dialog[open]')
        || focused?.closest('[role="listbox"], .n-menu')) return
      event.preventDefault()
      event.stopPropagation()
      onSelect({ kind: 'none' })
    }
    const rememberFocus = (event: FocusEvent) => {
      heldFocus.current = panel.contains(event.target as Node | null)
    }
    // A removed focused portal control leaves focus on body; other surfaces retain their own Escape.
    document.addEventListener('keydown', close)
    document.addEventListener('focusin', rememberFocus)
    return () => {
      document.removeEventListener('keydown', close)
      document.removeEventListener('focusin', rememberFocus)
    }
  }, [active, modalOpen, onSelect])
  useEffect(() => {
    if (!active) return
    const openedFrom = opener.current
    return () => { if (openedFrom?.isConnected) openedFrom.focus() }
  }, [active, opener])
  const content = modalOpen ? null : selection.kind === 'browser'
      ? slots?.browser?.({ ...selection, workspaceId, workflowId, ...(runId ? { runId } : {}),
        ...(workflowVersionId ? { workflowVersionId } : {}) }) ?? <p role="status">Browser is not available yet. No browser session has been started.</p>
      : selection.kind === 'agent' && selection.tab === 'chat'
        ? slots?.executionChat?.({ workspaceId, workflowId, ...(runId ? { runId } : {}),
          onSelectTarget, onSelectRun,
          ...(workflowVersionId ? { workflowVersionId } : {}), nodeId: selection.nodeId,
          ...(selection.executionId ? { executionId: selection.executionId } : {}),
          ...(selection.waitingActivationId ? { waitingActivationId: selection.waitingActivationId } : {}) })
          ?? (selection.executionId || selection.waitingActivationId ? <p role="status">Chat for this selected execution is not available yet. Your execution selection is kept.</p> : null)
        : null
  const agentName = agentSelection ? workflow.data?.workflow.nodes.find(node => node.id === agentSelection.nodeId) : undefined
  const title = selection.kind === 'browser' ? 'Browser'
    : agentName ? agentName.name ?? agentName.label ?? 'Agent' : 'Agent'
  return <aside ref={panelRef} tabIndex={-1} className="workflow-floating-panel" aria-label="Workflow side panel"
    hidden={!active || modalOpen} inert={!active || modalOpen}>
    {/* One compact row: title and close; the view tabs sit in the footer, below the composer. */}
    <header onPointerDown={drag}>
      <h2>{title}</h2>
      <div className="workflow-panel-header-slot" ref={headerSlotRef} onPointerDown={event => event.stopPropagation()} />
      <IconButton label="Back to Board" variant="ghost" onClick={() => onSelect({ kind: 'none' })}><Icon name="close" size={16} /></IconButton>
    </header>
    {!agentSelection ? <p className="workflow-panel-hint">Select an agent on the Board to see its chat and settings.</p> : null}
    {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const).map(edge =>
      <span key={edge} className="workflow-panel-resize" data-edge={edge} aria-hidden="true" onPointerDown={resize} />)}
    <div className="workflow-floating-panel-body" ref={attach}>{modalOpen ? null : content}</div>
    <footer className="workflow-panel-footer">
      <div className="workflow-panel-footer-slot" ref={footerSlotRef} />
      <nav className="workflow-panel-tabs" aria-label="Workflow panel view">
        {tabs.map(([tab, label]) => <Button key={tab} size="sm" variant="ghost" disabled={!agentSelection}
          aria-pressed={selection.kind === 'agent' && selection.tab === tab}
          onClick={() => { if (agentSelection) onSelect({ ...agentSelection, tab }) }}>{label}</Button>)}
        <IconButton label="Browser" size="sm" variant="ghost" aria-pressed={selection.kind === 'browser'} onClick={() => onSelect({ kind: 'browser' })}>
          <Icon name="globe" size={15} /></IconButton>
      </nav>
    </footer>
  </aside>
}

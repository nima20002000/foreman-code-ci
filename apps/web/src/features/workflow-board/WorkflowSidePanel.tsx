import { useCallback, useEffect, useLayoutEffect, useRef, useState, type PointerEvent as ReactPointerEvent, type ReactNode, type RefCallback, type RefObject } from 'react'
import type { BoardSidePanel } from '@foreman-code/contracts/wave25'
import type { HierarchyReport } from '@foreman-code/contracts'
import { Button, Dialog, Icon, IconButton } from '../../shared/ui/nocturne'
import { placeBeside } from '../../shared/ui/floatingWindow'
import { useSidePanelScroll } from './sidePanelPresentation'
import type { CollaborationFieldSlots } from '../graph/collaborationFields'
import type { WorkflowExecutionChatSlotSelection } from '../workflow-hierarchy/execution-chat/types'

export interface WorkflowCollaborationSlots extends CollaborationFieldSlots {
  groupChat?(scope: { workspaceId: string; workflowId: string; runId?: string }): ReactNode
  /** URL-owned selection. F3 resolves it through the canonical delivery target service. */
  executionChat?(selection: WorkflowExecutionChatSlotSelection): ReactNode
  browser?(selection: Extract<BoardSidePanel, { kind: 'browser' }> & {
    workspaceId: string; workflowId: string; runId?: string; workflowVersionId?: string
  }): ReactNode
  /** B retains exact release identity and minimal reconciliation after its body unmounts. */
  beforeBrowserHide?(): void | Promise<void>
  browserRecovery?(): ReactNode
  overview?(): ReactNode
  memoryBoard?(): ReactNode
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
  modalOpen: boolean
  slots?: WorkflowCollaborationSlots
}

const destinations = [['agent', 'Agent'], ['browser', 'Browser']] as const

/** Floating, draggable, resizable window opened next to the selected node. Only the selected body mounts;
 * the portal host preserves existing conversation/store ownership. */
export function WorkflowSidePanel({ scope, workspaceId, workflowId, runId, workflowVersionId,
  opener, selection, agentSelection, onSelect, onSelectTarget, onSelectRun, bodyRef, modalOpen, slots }: WorkflowSidePanelProps) {
  const panelRef = useRef<HTMLElement>(null)
  const heldFocus = useRef(false)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const attach = useCallback((element: HTMLDivElement | null) => { setHost(element); bodyRef(element) }, [bodyRef])
  useSidePanelScroll(host, JSON.stringify([scope, runId, selection]), modalOpen)
  const groupChat = selection.kind === 'group_chat'
  const active = selection.kind !== 'none'
  // Open next to the node that opened it; keep the user's position while it stays open.
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!active || modalOpen || !panel) return
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true })
    if (panel.dataset.placed) return
    const { left, top } = placeBeside(panel.offsetWidth, panel.offsetHeight, opener.current?.getBoundingClientRect())
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
  const content = modalOpen ? null : groupChat
    ? slots?.groupChat?.({ workspaceId, workflowId, ...(runId ? { runId } : {}) }) ?? <p role="status">Group chat is not available yet.</p>
    : selection.kind === 'browser'
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
  return <aside ref={panelRef} tabIndex={-1} className="workflow-floating-panel" aria-label="Workflow side panel"
    hidden={!active || modalOpen} inert={!active || modalOpen}>
    <header onPointerDown={drag}>
      <h2>{groupChat ? 'Group chat' : selection.kind === 'browser' ? 'Browser' : 'Agent'}</h2>
      <IconButton label={groupChat ? 'Close group chat' : 'Back to Board'} variant="ghost" onClick={() => onSelect({ kind: 'none' })}><Icon name="close" size={16} /></IconButton>
    </header>
    {groupChat ? null : <><nav aria-label="Workflow panel destination">
      {destinations.map(([kind, label]) => <Button key={kind} size="sm" variant="ghost"
        aria-pressed={selection.kind === kind} disabled={kind === 'agent' && !agentSelection}
        onClick={() => {
          if (kind === 'agent') { if (agentSelection) onSelect(agentSelection) }
          else onSelect({ kind })
        }}>{label}</Button>)}
    </nav>
    {!agentSelection ? <p className="workflow-panel-hint">Select a node on the Board to open Agent chat or settings.</p> : null}</>}
    {selection.kind === 'agent' ? <nav aria-label="Agent panel view">
      {(['chat', 'settings', 'details'] as const).map(tab => <Button key={tab} size="sm" variant="ghost"
        aria-pressed={selection.tab === tab} onClick={() => onSelect({ ...selection, tab })}>
        {tab === 'chat' ? 'Chat' : tab === 'settings' ? 'Settings' : 'Details'}</Button>)}
    </nav> : null}
    <div className="workflow-floating-panel-body" ref={attach}>{modalOpen ? null : content}</div>
  </aside>
}

export function WorkflowMemoryDialog({ open, onOpenChange, slots }: {
  open: boolean; onOpenChange(open: boolean): void; slots?: WorkflowCollaborationSlots
}) {
  return <Dialog open={open} onOpenChange={onOpenChange} title="Memory board" closeLabel="Close Memory board">
    {open ? slots?.memoryBoard?.() ?? <p role="status">Memory board is not available yet.</p> : null}
  </Dialog>
}

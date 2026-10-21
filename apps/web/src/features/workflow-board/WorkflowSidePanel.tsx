import { useCallback, useEffect, useState, type CSSProperties, type ReactNode, type RefCallback, type RefObject } from 'react'
import type { BoardSidePanel } from '@foreman-code/contracts/wave25'
import { Button, Dialog, Slider } from '../../shared/ui/nocturne'
import { useOperatorChatStore } from '../operator-chat/operatorChatStore'
import { useSidePanelPresentation, useSidePanelScroll } from './sidePanelPresentation'

export interface WorkflowCollaborationSlots {
  groupChat?(): ReactNode
  browser?(selection: Extract<BoardSidePanel, { kind: 'browser' }>): ReactNode
  overview?(): ReactNode
  memoryBoard?(): ReactNode
}

export interface WorkflowSidePanelProps {
  scope: string
  runId?: string
  opener: RefObject<HTMLElement | null>
  selection: BoardSidePanel
  agentSelection?: Extract<BoardSidePanel, { kind: 'agent' }>
  onSelect(selection: BoardSidePanel): void
  bodyRef: RefCallback<HTMLDivElement>
  modalOpen: boolean
  slots?: WorkflowCollaborationSlots
}

const destinations = [
  ['group_chat', 'Group chat'], ['agent', 'Agent'], ['browser', 'Browser'], ['operator', 'Operator'],
] as const

/** Only the selected body mounts. The fixed portal host preserves existing conversation/store ownership. */
export function WorkflowSidePanel({ scope, runId, opener, selection, agentSelection, onSelect, bodyRef, modalOpen, slots }: WorkflowSidePanelProps) {
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const width = useSidePanelPresentation(state => state.widths[scope] ?? 420)
  const conversationId = useOperatorChatStore(state => state.selectedConversationId)
  const attach = useCallback((element: HTMLDivElement | null) => { setHost(element); bodyRef(element) }, [bodyRef])
  useSidePanelScroll(host, JSON.stringify([scope, runId, selection,
    selection.kind === 'operator' ? conversationId : undefined]), modalOpen)
  const active = selection.kind !== 'none'
  useEffect(() => {
    if (!active) return
    const openedFrom = opener.current
    return () => { if (openedFrom?.isConnected) openedFrom.focus() }
  }, [active, opener])
  const content = modalOpen ? null : selection.kind === 'group_chat'
    ? slots?.groupChat?.() ?? <p role="status">Group chat is not available yet.</p>
    : selection.kind === 'browser'
      ? slots?.browser?.(selection) ?? <p role="status">Browser is not available yet. No browser session has been started.</p>
      : selection.kind === 'agent' && selection.executionId
        ? <p role="status">Chat for this selected execution is not available yet. Your execution selection is kept.</p>
        : null
  return <aside className="workflow-side-panel" aria-label="Workflow side panel"
    style={{ '--workflow-rail-width': `${width}px` } as CSSProperties}
    hidden={!active || modalOpen} inert={!active || modalOpen}
    onKeyDown={event => {
      if (event.key === 'Escape' && !event.defaultPrevented) {
        event.preventDefault(); event.stopPropagation(); onSelect({ kind: 'none' })
      }
    }}>
    <header>
      <h2>{destinations.find(([kind]) => kind === selection.kind)?.[1] ?? 'Agent'}</h2>
      <Button size="sm" variant="ghost" onClick={() => onSelect({ kind: 'none' })}>Back to Board</Button>
    </header>
    <nav aria-label="Workflow panel destination">
      {destinations.map(([kind, label]) => <Button key={kind} size="sm" variant="ghost"
        aria-pressed={selection.kind === kind} disabled={kind === 'agent' && !agentSelection}
        onClick={() => {
          if (kind === 'agent') { if (agentSelection) onSelect(agentSelection) }
          else onSelect({ kind })
        }}>{label}</Button>)}
    </nav>
    {!agentSelection ? <p className="workflow-panel-hint">Select a node on the Board to open Agent chat or settings.</p> : null}
    {selection.kind === 'agent' ? <nav aria-label="Agent panel view">
      {(['chat', 'settings', 'details'] as const).map(tab => <Button key={tab} size="sm" variant="ghost"
        aria-pressed={selection.tab === tab} onClick={() => onSelect({ ...selection, tab })}>
        {tab === 'chat' ? 'Chat' : tab === 'settings' ? 'Settings' : 'Details'}</Button>)}
    </nav> : null}
    <div className="workflow-rail-size"><Slider label="Panel width" min={320} max={640} value={width}
      onValueChange={value => useSidePanelPresentation.getState().setWidth(scope, value)} format={value => `${value} px`} /></div>
    <div className="workflow-side-panel-body" ref={attach}>{modalOpen ? null : content}</div>
  </aside>
}

export function WorkflowMemoryDialog({ open, onOpenChange, slots }: {
  open: boolean; onOpenChange(open: boolean): void; slots?: WorkflowCollaborationSlots
}) {
  return <Dialog open={open} onOpenChange={onOpenChange} title="Memory board" closeLabel="Close Memory board">
    {open ? slots?.memoryBoard?.() ?? <p role="status">Memory board is not available yet.</p> : null}
  </Dialog>
}

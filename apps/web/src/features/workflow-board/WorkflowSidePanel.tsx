import { useCallback, useState, type ReactNode, type RefCallback, type RefObject } from 'react'
import type { BoardSidePanel } from '@foreman-code/contracts/current'
import type { HierarchyReport } from '@foreman-code/contracts'
import { Button, Icon, IconButton } from '../../shared/ui/nocturne'
import { FloatingWindow } from '../../shared/ui/FloatingWindow'
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
  /** The floating window of live Agent browsers in the selected Run, one tab per Agent. */
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
  savedNodeName?: string
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

/** Floating, draggable, resizable window opened next to the selected node. Only the selected body mounts;
 * the portal host preserves existing conversation/store ownership. */
export function WorkflowSidePanel({ scope, workspaceId, workflowId, runId, workflowVersionId, savedNodeName,
  opener, selection, agentSelection, onSelect, onSelectTarget, onSelectRun, bodyRef, headerSlotRef, footerSlotRef, modalOpen, slots }: WorkflowSidePanelProps) {
  const workflow = useManagedWorkflowQuery(workspaceId, workflowId)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const attach = useCallback((element: HTMLDivElement | null) => { setHost(element); bodyRef(element) }, [bodyRef])
  useSidePanelScroll(host, JSON.stringify([scope, runId, selection]), modalOpen)
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
    : savedNodeName ?? (agentName ? agentName.name ?? agentName.label ?? 'Agent' : 'Agent')
  return <FloatingWindow active={selection.kind !== 'none'} modalOpen={modalOpen} opener={opener}
    label="Workflow side panel" title={title} closeLabel="Back to Board" onClose={() => onSelect({ kind: 'none' })}
    header={<div className="workflow-panel-header-slot" ref={headerSlotRef} onPointerDown={event => event.stopPropagation()} />}
    hint={!agentSelection ? <p className="workflow-panel-hint">Select an agent on the Board to see its chat and settings.</p> : null}
    bodyRef={attach} footer={
    <footer className="workflow-panel-footer">
      <div className="workflow-panel-footer-slot" ref={footerSlotRef} />
      <nav className="workflow-panel-tabs" aria-label="Workflow panel view">
        {tabs.map(([tab, label]) => <Button key={tab} size="sm" variant="ghost" disabled={!agentSelection}
          aria-pressed={selection.kind === 'agent' && selection.tab === tab}
          onClick={() => { if (agentSelection) onSelect({ ...agentSelection, tab }) }}>{label}</Button>)}
        <IconButton label="Browser" size="sm" variant="ghost" aria-pressed={selection.kind === 'browser'} onClick={() => onSelect({ kind: 'browser' })}>
          <Icon name="globe" size={15} /></IconButton>
      </nav>
    </footer>}>{modalOpen ? null : content}</FloatingWindow>
}

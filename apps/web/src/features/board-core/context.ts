import type { GraphGeometryChange } from './geometry'
import { createContext, createElement, useContext, useMemo, type ReactNode } from 'react'
import type { BoardSidePanel, RepeatGraphScopeCurrent, WorkspaceBoardInspection } from '@foreman-code/contracts/current'
import type { CollaborationFieldSlots } from './collaborationFields'
import type { NodeBrowserSettings } from '@foreman-code/contracts'

export type WorkflowAuthoringActions = {
  openWorkflowSettings(): void
  draftNodeAgentId(nodeId: string): string | undefined
  /** The draft node's current browser switch, applied or not; undefined when the node is not in the draft. */
  draftNodeBrowser(nodeId: string): NodeBrowserSettings | null | undefined
  /** Saves only a draft node's Agent and its configuration, never the workflow graph; resolves to its Agent id. */
  saveChatAgent(nodeId: string): Promise<string | undefined>
  /** Moves draft nodes exactly as dragging them on the draft Board does. */
  moveNodes?(changes: GraphGeometryChange[]): void
}

/** What the Board shows and selects: workflow, Run, inspection, side panel, view and navigation callbacks. */
export type WorkflowBoardSelection = {
  workspaceId: string; workflowId: string; run?: RepeatGraphScopeCurrent
  selectedAgentId?: string; selectDraftAgent?(agentId?: string): void
  inspection: WorkspaceBoardInspection
  selectInspection(inspection: WorkspaceBoardInspection): void
  selectRun(scope?: RepeatGraphScopeCurrent): void
  getSelectionToken?(): unknown
  openLocation(): void
  openRuns(): void
  navigationControls?: ReactNode
  authoringActive?: boolean
  sidePanel?: BoardSidePanel
  selectedPanelNodeId?: string
  selectSidePanel?(selection: BoardSidePanel): void
  memoryOpen?: boolean
  /** Opens the workflow's memory board on one card, as the Kanban's cards do. */
  openMemoryCard?(cardId: string): void
  canvasVisible?: boolean
  teamNodeId?: string
  selectTeam?(nodeId?: string): void
  /** Active or recovering Runs in the workspace; saving meaningful edits may stop them. */
  activeRuns: number
  /** The newest active Run of this workflow, if any. */
  liveRunId?: string
}

/** DOM nodes the Board renders and portals content into. They change only when those nodes mount. */
export type WorkflowBoardHosts = {
  sidePanelHost?: HTMLDivElement | null
  /** Where a shown Run puts its caption (worktree, computers, Read only): inside the Board's floating toolbar. */
  runCaptionHost?: HTMLDivElement | null
}

/** The editable draft's actions and the collaboration slots its fields render. */
export type WorkflowBoardAuthoring = {
  registerAuthoringActions?(actions?: WorkflowAuthoringActions): void
  /** Present while the editable draft is mounted, so a draft-only Agent's chat can save that Agent first. */
  saveChatAgent?(nodeId: string): Promise<string | undefined>
  /** The draft node's Agent, also before the node is saved. */
  draftNodeAgentId?(nodeId: string): string | undefined
  draftNodeBrowser?(nodeId: string): NodeBrowserSettings | null | undefined
  /** The draft Board's own layout change (manual places, saved as a layout revision), for dragging on a shown Run. */
  moveDraftNodes?(changes: GraphGeometryChange[]): void
  executionChatMounted?: boolean
  collaborationFields?: CollaborationFieldSlots
}

/** Callbacks and presentation context only; neither drafts nor Run facts live here. */
export type WorkflowBoardValue = WorkflowBoardSelection & WorkflowBoardHosts & WorkflowBoardAuthoring

export const BoardSelectionContext = createContext<WorkflowBoardSelection | null>(null)
export const BoardHostsContext = createContext<WorkflowBoardHosts | null>(null)
export const BoardAuthoringContext = createContext<WorkflowBoardAuthoring | null>(null)

export const useBoardSelection = () => useContext(BoardSelectionContext)
export const useBoardHosts = () => useContext(BoardHostsContext)
export const useBoardAuthoring = () => useContext(BoardAuthoringContext)

/** The whole Board context. Prefer the focused hooks: this one changes whenever any part changes. */
export function useWorkflowBoard(): WorkflowBoardValue | null {
  const selection = useBoardSelection(), hosts = useBoardHosts(), authoring = useBoardAuthoring()
  return useMemo(() => selection ? { ...authoring, ...hosts, ...selection } : null, [selection, hosts, authoring])
}

/** Provides each part of an already assembled Board value (tests and small embeddings). */
export function WorkflowBoardProvider({ value, children }: { value: WorkflowBoardValue; children?: ReactNode }) {
  const { sidePanelHost, runCaptionHost, registerAuthoringActions, saveChatAgent, draftNodeAgentId, draftNodeBrowser,
    moveDraftNodes, executionChatMounted, collaborationFields, ...selection } = value
  const hosts = useMemo(() => ({ sidePanelHost, runCaptionHost }), [sidePanelHost, runCaptionHost])
  const authoring = useMemo(() => ({ registerAuthoringActions, saveChatAgent, draftNodeAgentId, draftNodeBrowser,
    moveDraftNodes, executionChatMounted, collaborationFields }), [registerAuthoringActions, saveChatAgent,
    draftNodeAgentId, draftNodeBrowser, moveDraftNodes, executionChatMounted, collaborationFields])
  return createElement(BoardSelectionContext.Provider, { value: selection },
    createElement(BoardHostsContext.Provider, { value: hosts },
      createElement(BoardAuthoringContext.Provider, { value: authoring }, children)))
}

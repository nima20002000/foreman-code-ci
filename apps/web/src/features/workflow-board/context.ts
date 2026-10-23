import type { GraphGeometryChange } from '../graph/geometry'
import { createContext, useContext, type ReactNode } from 'react'
import type { BoardSidePanel, RepeatGraphScopeV3, WorkspaceBoardInspection } from '@foreman-code/contracts/wave25'
import type { CollaborationFieldSlots } from '../graph/collaborationFields'
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

/** Callbacks and presentation context only; neither drafts nor Run facts live here. */
export const WorkflowBoardContext = createContext<{
  workspaceId: string; workflowId: string; run?: RepeatGraphScopeV3
  selectedAgentId?: string; selectDraftAgent?(agentId?: string): void
  inspection: WorkspaceBoardInspection
  selectInspection(inspection: WorkspaceBoardInspection): void
  selectRun(scope?: RepeatGraphScopeV3): void
  getSelectionToken?(): unknown
  openLocation(): void
  openRuns(): void
  navigationControls?: ReactNode
  authoringActive?: boolean
  registerAuthoringActions?(actions?: WorkflowAuthoringActions): void
  /** Present while the editable draft is mounted, so a draft-only Agent's chat can save that Agent first. */
  saveChatAgent?(nodeId: string): Promise<string | undefined>
  /** The draft node's Agent, also before the node is saved. */
  draftNodeAgentId?(nodeId: string): string | undefined
  draftNodeBrowser?(nodeId: string): NodeBrowserSettings | null | undefined
  sidePanel?: BoardSidePanel
  selectedPanelNodeId?: string
  selectSidePanel?(selection: BoardSidePanel): void
  sidePanelHost?: HTMLDivElement | null
  /** Where a shown Run puts its caption (worktree, computers, Read only): inside the Board's floating toolbar. */
  runCaptionHost?: HTMLDivElement | null
  /** The draft Board's own layout change (manual places, saved as a layout revision), for dragging on a shown Run. */
  moveDraftNodes?(changes: GraphGeometryChange[]): void
  executionChatMounted?: boolean
  collaborationFields?: CollaborationFieldSlots
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
} | null>(null)
export const useWorkflowBoard = () => useContext(WorkflowBoardContext)

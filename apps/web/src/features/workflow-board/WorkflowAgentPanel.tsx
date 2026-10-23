import { createPortal } from 'react-dom'
import type { AgentPanelRenderer, PinnedPanelNode } from '../graph'
import { useWorkflowBoard } from '../board-core'

/** Existing Agent components retain their stores; only their frame changes. */
export function WorkflowAgentPanel({ panels, findNode, active = true }: {
  panels: AgentPanelRenderer
  findNode(nodeId: string): PinnedPanelNode | false | undefined
  active?: boolean
}) {
  const board = useWorkflowBoard()
  const selection = board?.sidePanel
  if (!active || !board?.sidePanelHost || board.memoryOpen || selection?.kind !== 'agent'
    || selection.tab === 'chat' && (selection.executionId || board.executionChatMounted)) return null
  const node = findNode(selection.nodeId)
  const body = node === false ? <p role="status">This agent is not in this workflow or run.</p>
    : panels(selection.nodeId, node)[selection.tab === 'details' ? 'info' : selection.tab]
  return createPortal(body, board.sidePanelHost)
}

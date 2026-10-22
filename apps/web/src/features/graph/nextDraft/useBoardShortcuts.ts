import { useEffect, useRef } from 'react'
import { isHierarchyReportingRoute, type Agent } from '@foreman-code/contracts'
import type { WorkflowDefinitionV3, WorkflowRelationship } from '@foreman-code/contracts/wave25'
import { useGraphDraftStore } from '../store'
import { changeDraftAgents, editorAgents } from './agentEdits'
import type { NextDraftEdit } from './state'
import type { DraftEditorCore } from './useDraftEditorCore'
import type { useWorkflowBoard } from '../../workflow-board/context'
import { hierarchyNodes, removeHierarchyNode, stageHierarchyAgent } from '../../workflow-hierarchy/authoring'
import { currentBoardView, pinBoardLayout, placePastedNodes, type BoardView } from './placement'
import { modalOpen } from '../../../shared/ui/modalOpen'

type AgentNode = Exclude<WorkflowDefinitionV3['nodes'][number], { kind: 'job' }>
type Copied = { nodes: AgentNode[]; agents: Agent[]; parents: Record<string, string>; edges: WorkflowRelationship[]; pastes: number }
/** In-app clipboard: a copy survives switching workflows in this tab. */
let copied: Copied | undefined

const TYPING = 'input, textarea, select, [contenteditable]:not([contenteditable="false"]), [role="textbox"], [role="dialog"], dialog, .workflow-floating-panel'

function selectedIds(core: DraftEditorCore, graph: WorkflowDefinitionV3) {
  return [...core.presentation.getState().selectedNodeIds].filter(id => graph.nodes.some(node => node.id === id))
}

/** Removes nodes as one Undo step. An Orchestrator with Workers asks where they go first. */
function remove(draftKey: string, edit: NextDraftEdit, ids: string[]) {
  const single = ids.length === 1 ? ids[0]! : undefined
  if (single && edit.graph.hierarchy?.masterNodeId !== single
    && edit.graph.hierarchy?.parents.some(member => member.parentNodeId === single)) {
    useGraphDraftStore.getState().updateNextDraft(draftKey, current => ({ ...current,
      workflowForms: { ...current.workflowForms, removeNode: { nodeId: single, destinationParentId: '' } } }))
    return
  }
  useGraphDraftStore.getState().updateNextDraft(draftKey, current => {
    // The remaining nodes stay where they are.
    const removed = ids.reduce((value, id) => value.graph.nodes.some(node => node.id === id) ? removeHierarchyNode(value, id) : value, pinBoardLayout(current))
    return changeDraftAgents({ ...current, agentForms: removed.agentForms, workflowForms: removed.workflowForms }, [], removed.graph)
  })
}

function copy(shown: NextDraftEdit, ids: string[]): boolean {
  // Copies carry the place each node is shown at, so a paste lands beside them.
  const edit = pinBoardLayout(shown)
  const agents = new Map(editorAgents(edit).map(agent => [agent.id, agent]))
  const nodes = edit.graph.nodes.filter((node): node is AgentNode => node.kind !== 'job' && ids.includes(node.id) && agents.has(node.agentId))
  if (!nodes.length) return false
  const nodeIds = new Set(nodes.map(node => node.id))
  copied = structuredClone({
    nodes, agents: nodes.map(node => agents.get(node.agentId)!),
    parents: Object.fromEntries((edit.graph.hierarchy?.parents ?? []).filter(member => nodeIds.has(member.workflowNodeId))
      .map(member => [member.workflowNodeId, member.parentNodeId])),
    edges: edit.graph.edges.filter(edge => nodeIds.has(edge.source) && nodeIds.has(edge.target)
      && !isHierarchyReportingRoute(edit.graph.hierarchy, edge)),
    pastes: 0,
  })
  return true
}

const roleOrder = { master: 0, orchestrator: 1, coder: 2 } as const

/** Pastes copies with new identities as one Undo step; returns the new node ids. */
function paste(draftKey: string, clipboard: Copied, view?: BoardView): string[] {
  clipboard.pastes += 1
  const ids = new Map(clipboard.nodes.map(node => [node.id, `node-${crypto.randomUUID()}`]))
  useGraphDraftStore.getState().updateNextDraft(draftKey, current => {
    // Pasting never moves the nodes already on the Board.
    let scratch = pinBoardLayout(current)
    const created: Agent[] = []
    const order = clipboard.nodes.map((node, index) => ({ node, agent: clipboard.agents[index]! }))
      .sort((a, b) => roleOrder[a.agent.productRole ?? 'coder'] - roleOrder[b.agent.productRole ?? 'coder'])
    for (const { node, agent: source } of order) {
      // A Board has one Master: a copied Master joins as an Orchestrator when this Board already leads with one.
      const hasMaster = !!scratch.graph.hierarchy || hierarchyNodes(scratch).some(item => item.role === 'master')
      const productRole = source.productRole === 'master' && hasMaster ? 'orchestrator' : source.productRole
      const agent: Agent = { ...structuredClone(source), id: `agent-${crypto.randomUUID()}`, name: `${source.name} copy`,
        ...(productRole ? { productRole } : {}) }
      for (const key of ['configurationVersionId', 'createdAt', 'updatedAt', 'status', 'executionState', 'activeRunId', 'harnessSummary'] as const) delete agent[key]
      const original = clipboard.parents[node.id]
      const orchestrators = hierarchyNodes(scratch).filter(item => item.role === 'orchestrator').map(item => item.node.id)
      const parent = productRole !== 'coder' || !scratch.graph.hierarchy ? undefined
        : [original && ids.get(original), original].find(id => id && orchestrators.includes(id))
      const nodeId = ids.get(node.id)!
      scratch = stageHierarchyAgent(scratch, agent, nodeId, parent)
      // Identity, name and outcome routes belong to the original; every other node setting is copied.
      const { position, ...fields } = structuredClone(node)
      for (const key of ['id', 'agentId', 'name', 'label', 'choice'] as const) delete fields[key]
      scratch = { ...scratch, graph: { ...scratch.graph, nodes: scratch.graph.nodes.map(item => item.id !== nodeId || item.kind === 'job' ? item : { ...item, ...fields,
        ...(position ? { position: { x: position.x, y: position.y, manual: true } } : {}) }) } }
      created.push(agent)
    }
    const edges = clipboard.edges.map(edge => ({ ...edge, id: `relationship-${crypto.randomUUID()}`,
      source: ids.get(edge.source)!, target: ids.get(edge.target)! }))
    // Copies land together on free space beside the originals, never on top of them.
    const placed = placePastedNodes({ ...scratch, graph: { ...scratch.graph, edges: [...scratch.graph.edges, ...edges] } }, [...ids.values()], view)
    return changeDraftAgents(current, created, placed.graph)
  })
  return [...ids.values()]
}

/** Delete/Backspace removes the selected nodes; Ctrl/Cmd+C and Ctrl/Cmd+V copy and paste selected Agents.
 * Keys typed into fields, dialogs and the floating side panel are left alone. */
export function useBoardShortcuts({ draftKey, core, board, disabled }: {
  draftKey: string; core: DraftEditorCore; board: ReturnType<typeof useWorkflowBoard>; disabled: boolean
}) {
  const latest = useRef({ core, board, disabled })
  latest.current = { core, board, disabled }
  useEffect(() => {
    const shortcut = (event: KeyboardEvent) => {
      const { core, board, disabled } = latest.current
      if (event.defaultPrevented || event.altKey || event.isComposing || disabled || board?.run
        || board?.authoringActive === false || board?.canvasVisible === false || board?.memoryOpen) return
      const target = event.target
      if (target instanceof Element && (target.closest(TYPING) || (target !== document.body && !target.closest('.next-draft-canvas')))) return
      if (modalOpen()) return
      const edit = useGraphDraftStore.getState().nextDrafts[draftKey]
      if (!edit || edit.busy || edit.pending) return
      const command = event.ctrlKey || event.metaKey
      const key = event.key.toLowerCase()
      try {
        if (!command && !event.shiftKey && (event.key === 'Delete' || event.key === 'Backspace')) {
          const ids = selectedIds(core, edit.graph)
          if (!ids.length) return
          event.preventDefault()
          core.canvas.current?.flush()
          remove(draftKey, edit, ids)
          if (board?.sidePanel?.kind === 'agent' && ids.includes(board.sidePanel.nodeId)) board.selectSidePanel?.({ kind: 'none' })
          core.presentation.getState().setSelectedNodeIds(new Set())
          core.presentation.getState().setFocusedNodeId(undefined)
        } else if (command && !event.shiftKey && key === 'c') {
          if (window.getSelection()?.toString()) return
          if (copy(edit, selectedIds(core, edit.graph))) event.preventDefault()
        } else if (command && !event.shiftKey && key === 'v' && copied) {
          event.preventDefault()
          core.canvas.current?.flush()
          const pasted = paste(draftKey, copied, currentBoardView())
          core.presentation.getState().setSelectedNodeIds(new Set(pasted))
          core.presentation.getState().setFocusedNodeId(pasted.at(-1))
        }
      } catch (error) { core.report(error) }
    }
    window.addEventListener('keydown', shortcut)
    return () => window.removeEventListener('keydown', shortcut)
  }, [draftKey])
}

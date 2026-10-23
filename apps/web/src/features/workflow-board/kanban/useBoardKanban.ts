import { useMemo, useState } from 'react'
import type { NodeChange } from '@xyflow/react'
import type { WorkflowKanbanFrame, WorkflowKanbanLayout } from '@foreman-code/contracts'
import { useReducedMotion } from '../../../shared/ui/nocturne'
import { errorMessage } from '../../memory-boards/presentation'
import { KANBAN_NODE_ID, type KanbanActivityFlowEdge, type KanbanFlowNode } from './BoardKanban'
import { kanbanScope, useKanbanActivity } from './kanbanActivity'
import { useKanbanLayout } from './kanbanLayout'
import { CI_SERVER_SIZE } from '../inspect/ciServer'
import { useKanbanDocked } from '../dock/boardObjects'

type Placed = { position: { x: number; y: number }; width?: number | undefined; height?: number | undefined }
const DEFAULT_SIZE = { width: 760, height: 460 }

/** First placement: beside the Agents, to the right of the rightmost one. With no Agents yet, right of the
 * CI server, which then sits centered on the origin. */
export function defaultKanbanFrame(nodes: readonly Placed[]): WorkflowKanbanFrame {
  if (!nodes.length) return { x: CI_SERVER_SIZE.width / 2 + 160, y: 0, ...DEFAULT_SIZE }
  const right = Math.max(...nodes.map((node) => node.position.x + (node.width ?? 212)))
  return { x: right + 160, y: Math.min(...nodes.map((node) => node.position.y)), ...DEFAULT_SIZE }
}
const rounded = (frame: WorkflowKanbanFrame): WorkflowKanbanFrame =>
  ({ x: Math.round(frame.x), y: Math.round(frame.y), width: Math.round(frame.width), height: Math.round(frame.height) })

/** The Kanban object of one Board canvas: its flow node while shown, the lights from Agents that just changed
 * a card, and the handlers for moving and resizing it. Layout is saved per workflow on the server. */
export function useBoardKanban({ workspaceId, workflowId, nodes, nodeIds, enabled = true }: {
  workspaceId: string; workflowId: string; nodes: readonly Placed[]; nodeIds: ReadonlySet<string>; enabled?: boolean
}) {
  const { layout, read, save, saveError } = useKanbanLayout(workspaceId, workflowId, enabled)
  // A drag or resize in progress over this exact saved layout; any newer layout replaces it.
  const [moving, setMoving] = useState<{ base?: WorkflowKanbanLayout; frame: WorkflowKanbanFrame }>()
  const placed = useMemo(() => layout?.frame ?? defaultKanbanFrame(nodes), [layout?.frame, nodes])
  const frame = moving && moving.base === layout ? moving.frame : placed
  const actions = useMemo(() => ({
    store: (next: WorkflowKanbanFrame) => save({ visible: true, frame: rounded(next) }),
  }), [save])
  // Off by default: the toolbar's Kanban button puts it on the Board. Its X closes it into the dock; it appears
  // once its saved place is known, so it never jumps.
  const docked = useKanbanDocked({ workspaceId, workflowId })
  const onBoard = enabled && read && layout?.visible === true
  const visible = onBoard && !docked.closed
  const error = saveError ? errorMessage(saveError) : undefined
  const node = useMemo<KanbanFlowNode | undefined>(() => visible ? {
    id: KANBAN_NODE_ID, type: 'boardKanban', position: { x: frame.x, y: frame.y }, width: frame.width, height: frame.height,
    dragHandle: '.board-kanban-bar', draggable: true, selectable: false, connectable: false, deletable: false, focusable: false,
    data: { workspaceId, workflowId, ...(error ? { saveError: error } : {}), resized: actions.store, close: docked.close },
  } : undefined, [visible, frame, workspaceId, workflowId, error, actions, docked.close])
  const activity = useKanbanActivity((state) => state.items[kanbanScope(workspaceId, workflowId)])
  const reduced = useReducedMotion()
  const edges = useMemo<KanbanActivityFlowEdge[]>(() => !node || reduced ? [] : (activity ?? []).flatMap((item) =>
    item.pulsing && item.nodeId && nodeIds.has(item.nodeId) ? [{
      id: `kanban-activity:${item.key}`, type: 'kanbanActivity' as const, source: item.nodeId, target: KANBAN_NODE_ID,
      sourceHandle: 'right', targetHandle: 'left', selectable: false, focusable: false, deletable: false,
      data: { pulse: { key: item.key, signal: 'task' as const, reversed: false, startsAt: item.startsAt, word: 'Card updated' } },
    }] : []), [node, reduced, activity, nodeIds])
  /** Live drag and resize of the Kanban; every other change belongs to the canvas. */
  const applyChanges = (changes: readonly NodeChange[]) => {
    let next = frame
    for (const change of changes) {
      if (!('id' in change) || change.id !== KANBAN_NODE_ID) continue
      if (change.type === 'position' && change.position) next = { ...next, ...change.position }
      if (change.type === 'dimensions' && change.dimensions && change.resizing) next = { ...next, ...change.dimensions }
    }
    if (next !== frame) setMoving({ base: layout, frame: next })
  }
  /** React Flow reports the dropped position once the drag ends. */
  const moved = (position: { x: number; y: number }) => actions.store({ ...frame, ...position })
  const dock = onBoard && docked.closed ? { workspaceId, workflowId, restore: docked.restore } : undefined
  return { node, edges, applyChanges, moved, dock }
}

import type { Agent } from '@foreman-code/contracts'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { workflowToGraph } from '../mapper'
import { LAYOUT_GAP_Y } from '../hierarchyLayout'
import { editorAgents } from './agentEdits'
import type { NextDraftEdit } from './state'

type Box = { x: number; y: number; width: number; height: number }
/** The part of the Board the person currently sees, in Board coordinates. */
export type BoardView = { x: number; y: number; width: number; height: number
  /** Everything else drawn on the Board (the CI server, the Kanban) that a new node must not cover. */
  objects?: readonly (Box & { id: string })[] }

/** Pins every node where the Board shows it now, so adding, pasting, connecting or removing a node never
 * re-lays out (and moves) the others. Returns the same graph when every node is already placed. */
export function pinGraphLayout(graph: WorkflowDefinitionV3, agents: readonly Agent[]): WorkflowDefinitionV3 {
  if (graph.nodes.every(node => node.position?.manual)) return graph
  const shown = new Map(workflowToGraph({ workflow: graph, agents }).nodes.map(node => [node.id, node.position]))
  return { ...graph, nodes: graph.nodes.map(node => {
    const position = shown.get(node.id)
    return node.position?.manual || !position ? node : { ...node, position: { x: position.x, y: position.y, manual: true } }
  }) }
}

export function pinBoardLayout(edit: NextDraftEdit): NextDraftEdit {
  const graph = pinGraphLayout(edit.graph, editorAgents(edit))
  return graph === edit.graph ? edit : { ...edit, graph }
}

const GAP = 48
const overlaps = (a: Box, b: Box) => a.x < b.x + b.width + GAP && a.x + a.width + GAP > b.x && a.y < b.y + b.height + GAP && a.y + a.height + GAP > b.y
const within = (view: BoardView, box: Box) => box.x >= view.x && box.y >= view.y
  && box.x + box.width <= view.x + view.width && box.y + box.height <= view.y + view.height

/** The free spot nearest to `anchor` (a top-left corner), searched in widening rings; inside `view` when one is given. */
function freeSpot(occupied: readonly Box[], anchor: { x: number; y: number }, size: { width: number; height: number }, view?: BoardView) {
  const stepX = Math.max(GAP, size.width / 4), stepY = Math.max(GAP, size.height / 4)
  for (let ring = 0; ring < 40; ring++) {
    for (let dy = -ring; dy <= ring; dy++) for (let dx = -ring; dx <= ring; dx++) {
      if (Math.max(Math.abs(dx), Math.abs(dy)) !== ring) continue
      const box = { x: anchor.x + dx * stepX, y: anchor.y + dy * stepY, ...size }
      if ((!view || within(view, box)) && !occupied.some(item => overlaps(box, item))) return { x: box.x, y: box.y }
    }
  }
  return undefined
}

/** A new node goes below its parent when there is room in view, else as near the middle of what the Board shows
 * as there is free space. Other nodes keep their places. */
export function placeNewNode(edit: NextDraftEdit, nodeId: string, view?: BoardView): NextDraftEdit {
  const graph = edit.graph
  if (!graph.nodes.some(node => node.id === nodeId && !node.position?.manual)) return edit
  const shown = workflowToGraph({ workflow: graph, agents: editorAgents(edit) }).nodes
  const self = shown.find(node => node.id === nodeId)!
  const size = { width: self.width ?? 156, height: self.height ?? 156 }
  const box = (node: (typeof shown)[number]): Box => ({ x: node.position.x, y: node.position.y, width: node.width ?? 156, height: node.height ?? 156 })
  const others = shown.filter(node => node.id !== nodeId)
  const occupied = [...others.map(box), ...(view?.objects ?? []).filter(item => !shown.some(node => node.id === item.id))]
  const parentId = graph.hierarchy?.parents.find(member => member.workflowNodeId === nodeId)?.parentNodeId
  const parentNode = others.find(node => node.id === parentId), parent = parentNode && box(parentNode)
  const below = parent && { x: parent.x + parent.width / 2 - size.width / 2, y: parent.y + parent.height + LAYOUT_GAP_Y }
  const middle = view && { x: view.x + view.width / 2 - size.width / 2, y: view.y + view.height / 2 - size.height / 2 }
  const position = (below && freeSpot(occupied, below, size, view)) ?? (middle && freeSpot(occupied, middle, size, view))
    ?? (below && freeSpot(occupied, below, size)) ?? (middle && freeSpot(occupied, middle, size))
  if (!position) return edit
  const placed = { x: position.x, y: position.y, manual: true }
  return { ...edit, graph: { ...graph, nodes: graph.nodes.map(node => node.id === nodeId ? { ...node, position: placed } : node) } }
}

/** Moves pasted nodes together, keeping their arrangement, to the nearest free space beside their originals. */
export function placePastedNodes(edit: NextDraftEdit, nodeIds: readonly string[], view?: BoardView): NextDraftEdit {
  const graph = edit.graph, ids = new Set(nodeIds)
  const shown = workflowToGraph({ workflow: graph, agents: editorAgents(edit) }).nodes
  const pasted = shown.filter(node => ids.has(node.id))
  if (!pasted.length) return edit
  const boxes = pasted.map(node => ({ x: node.position.x, y: node.position.y, width: node.width ?? 156, height: node.height ?? 156 }))
  const left = Math.min(...boxes.map(item => item.x)), top = Math.min(...boxes.map(item => item.y))
  const size = { width: Math.max(...boxes.map(item => item.x + item.width)) - left, height: Math.max(...boxes.map(item => item.y + item.height)) - top }
  const occupied = [...shown.filter(node => !ids.has(node.id)).map(node => ({ x: node.position.x, y: node.position.y,
    width: node.width ?? 156, height: node.height ?? 156 })), ...(view?.objects ?? []).filter(item => !shown.some(node => node.id === item.id))]
  const anchor = { x: left + size.width + GAP, y: top }
  const spot = (view && freeSpot(occupied, anchor, size, view)) ?? freeSpot(occupied, anchor, size)
  if (!spot) return edit
  const dx = spot.x - left, dy = spot.y - top
  return { ...edit, graph: { ...graph, nodes: graph.nodes.map(node => {
    const from = ids.has(node.id) ? shown.find(item => item.id === node.id) : undefined
    return from ? { ...node, position: { x: from.position.x + dx, y: from.position.y + dy, manual: true } } : node
  }) } }
}

/** Reads the visible Board's pan and zoom from the page. */
export function currentBoardView(): BoardView | undefined {
  if (typeof document === 'undefined') return undefined
  const flow = [...document.querySelectorAll<HTMLElement>('.next-draft-canvas .react-flow')].find(item => item.getClientRects().length)
  const viewport = flow?.querySelector<HTMLElement>('.react-flow__viewport')
  if (!flow || !viewport) return undefined
  const matrix = new DOMMatrixReadOnly(getComputedStyle(viewport).transform)
  // The Board's toolbar floats over the top of the canvas; keep new nodes below it and off the edges.
  const zoom = matrix.a || 1, box = flow.getBoundingClientRect(), top = 80, side = 16
  const objects = [...flow.querySelectorAll<HTMLElement>('.react-flow__node')].flatMap(element => {
    const place = new DOMMatrixReadOnly(element.style.transform || 'none')
    return element.dataset.id ? [{ id: element.dataset.id, x: place.e, y: place.f, width: element.offsetWidth, height: element.offsetHeight }] : []
  })
  return { x: (side - matrix.e) / zoom, y: (top - matrix.f) / zoom,
    width: Math.max(0, box.width - 2 * side) / zoom, height: Math.max(0, box.height - top - side) / zoom, objects }
}

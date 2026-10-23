import type { Edge, Node, ReactFlowProps } from '@xyflow/react'
import type { RunBoardSnapshot, RunBoardNodeSnapshot, RunBoardEdgeSnapshot } from '@foreman-code/contracts/run-snapshots'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { roleNodeSize, workflowToGraph } from '../graph/mapper'
import { layoutHierarchy } from '../graph/hierarchyLayout'
import { edgeBend, relationshipLines } from '../graph/signalEdge'
import { agentProductRoleLabel, isHierarchyReportingRoute, type ActivitySnapshotV1, type Agent, type CiActivity, type WorkRef,
  type WorkflowHierarchyReadResult } from '@foreman-code/contracts'

export type AvailableRunBoardSnapshot = Extract<RunBoardSnapshot, { kind: 'available' }>
export type SavedBoardNode = Node<{ snapshot: RunBoardNodeSnapshot; role?: string; reportingParent?: string; ci?: CiActivity; inspect?: () => void }, 'savedBoardNode'>
/** One line per agent pair, as on the draft Board: an approval beside a handoff rides on the handoff's line. */
export type SavedBoardEdge = Edge<{ snapshot: RunBoardEdgeSnapshot; members: readonly RunBoardEdgeSnapshot[]; bend: number }, 'savedBoardEdge'>

/** No caller-provided canvas props may override these locks. Viewport movement is harmless. */
export const READ_ONLY_FLOW_PROPS = {
  nodesDraggable: false, nodesConnectable: false, edgesReconnectable: false,
  elementsSelectable: false, selectNodesOnDrag: false, selectionOnDrag: false,
  connectOnClick: false, deleteKeyCode: null, selectionKeyCode: null, multiSelectionKeyCode: null,
  disableKeyboardA11y: true, nodesFocusable: true, edgesFocusable: true,
} as const satisfies Partial<ReactFlowProps<SavedBoardNode, SavedBoardEdge>>

/** A presentation projection, never a draft installation or current-Agent lookup.
 * Copy mutable geometry for React Flow; retain the contract's readonly facts in data.
 * Lines follow the draft Board: one per agent pair, in snapshot order; each keeps its member edges' facts.
 */
export function projectRunBoard(snapshot: AvailableRunBoardSnapshot, activity?: ActivitySnapshotV1,
  hierarchy?: WorkflowHierarchyReadResult, layout?: RunBoardLayout): { nodes: SavedBoardNode[]; edges: SavedBoardEdge[] } {
  const names = new Map(snapshot.nodes.map((node) => [node.id, node.name]))
  const cis = runBoardCi(snapshot, activity)
  const saved = hierarchy?.workspaceId === snapshot.workspaceId && hierarchy.workflowId === snapshot.workflowId
    && hierarchy.workflowVersionId === snapshot.workflowVersionId && hierarchy.run?.runId === snapshot.runId ? hierarchy : undefined
  const identities = new Map(saved?.agents.filter(agent => snapshot.nodes.some(node => node.kind !== 'job'
    && node.id === agent.workflowNodeId && node.agentId === agent.agentId && node.agentConfigurationVersionId === agent.configurationVersionId))
    .map(agent => [agent.workflowNodeId, agent]))
  const geometry = runBoardGeometry(snapshot, saved, layout)
  const nodes: SavedBoardNode[] = snapshot.nodes.map((node) => ({
    id: node.id, type: 'savedBoardNode', position: { ...geometry.get(node.id)!.position }, origin: [0, 0],
    initialWidth: geometry.get(node.id)!.width, initialHeight: geometry.get(node.id)!.height,
    style: { width: geometry.get(node.id)!.width, height: geometry.get(node.id)!.height }, data: { snapshot: node,
      ...(identities.has(node.id) ? { role: agentProductRoleLabel(identities.get(node.id)!.productRole) } : {}),
      // The Master reports to no one, so it gets no "Reports to" caption.
      ...(saved?.hierarchy && node.id !== saved.hierarchy.masterNodeId ? { reportingParent:
        names.get(saved.hierarchy.parents.find(member => member.workflowNodeId === node.id)?.parentNodeId ?? '') ?? 'Unavailable' } : {}),
      ...(cis.has(node.id) ? { ci: cis.get(node.id)! } : {}) },
    draggable: false, connectable: false, selectable: false, deletable: false, focusable: true,
    ariaRole: 'group', ariaLabel: `${node.name}, saved ${node.kind==='job'?'job':'agent'}, read only`,
    domAttributes: { title: node.kind==='job'?`${node.name}\nJob: ${node.jobDefinitionId}\nRevision: ${node.jobDefinitionRevision}`:`${node.name}\nAgent: ${node.agentId}\nConfiguration: ${node.agentConfigurationVersionId}` },
  }))
  const counts = new Map<string, number>()
  const byId = new Map(snapshot.edges.map(edge => [edge.id, edge]))
  const edges: SavedBoardEdge[] = relationshipLines(snapshot.edges).lines.map(({ members, ...line }) => {
    const pair = JSON.stringify([line.source, line.target].sort()), count = counts.get(pair) ?? 0
    counts.set(pair, count + 1)
    const edge = byId.get(line.id)!
    const work = isHierarchyReportingRoute(saved?.hierarchy ?? undefined, edge) ? 'Orchestrates' : 'Handoff'
    const kind = members.length > 1 ? `${work} · approval` : edge.kind === 'approval' ? 'Approval' : work
    // A folded approval keeps its own direction and label on the shared line.
    const folded = members.filter(member => member.id !== edge.id).map(member => byId.get(member.id)!)
      .map(item => `; approval from ${names.get(item.source)} to ${names.get(item.target)}${item.label ? `: ${item.label}` : ''}`).join('')
    return {
      id: edge.id, type: 'savedBoardEdge', source: edge.source, target: edge.target,
      sourceHandle: edge.sourceHandle ?? 'right', targetHandle: edge.targetHandle ?? 'left',
      data: { snapshot: edge, members: members.map(member => byId.get(member.id)!), bend: edgeBend(count, edge.source < edge.target) },
      selectable: false, deletable: false, reconnectable: false, focusable: true,
      ariaRole: 'img',
      ariaLabel: `${kind} from ${names.get(edge.source)} to ${names.get(edge.target)}${edge.label ? `: ${edge.label}` : ''}${folded}, read only`,
    }
  })
  return { nodes, edges }
}

/** The Run's saved version, the mounted draft and the Board's Agents: with them a Run is drawn exactly where the
 * draft Board draws it. The draft wins for every node it has, so moving an agent on either view moves it on both. */
export type RunBoardLayout = { definition?: WorkflowDefinitionV3; draft?: WorkflowDefinitionV3; agents?: readonly Agent[] }

/** Same places and sizes as the draft Board: its mapper keeps manual places and saved sizes and lays out the rest.
 * A node the saved version lacks (or a Run read without it) falls back to the hierarchy layout at role size. */
function runBoardGeometry(snapshot: AvailableRunBoardSnapshot, saved: WorkflowHierarchyReadResult | undefined, layout?: RunBoardLayout) {
  // The Run's saved roles size its nodes; the draft's Agents only fill in before that read arrives.
  const known = new Map<string, Agent>((saved?.agents ?? []).map(agent =>
    [agent.agentId, { id: agent.agentId, name: agent.displayName, productRole: agent.productRole }]))
  for (const agent of layout?.agents ?? []) if (!known.has(agent.id)) known.set(agent.id, agent)
  const definition = layout?.definition
  const draw = (workflow?: WorkflowDefinitionV3) => workflow ? workflowToGraph({ workflow, agents: [...known.values()] }).nodes
    .map(node => [node.id, { position: node.position, width: node.width!, height: node.height! }] as const) : []
  const drawn = new Map([...draw(definition), ...draw(layout?.draft)])
  const masterNodeId = definition?.hierarchy?.masterNodeId ?? saved?.hierarchy?.masterNodeId
  const sizes = new Map(snapshot.nodes.map((node) => {
    const role = node.kind === 'job' ? undefined : known.get(node.agentId)?.productRole
    const diameter = roleNodeSize(masterNodeId === node.id ? 'master' : role === 'master' ? 'orchestrator' : role)
    return [node.id, { width: diameter, height: diameter }] as const
  }))
  const placed = layoutHierarchy(snapshot.nodes.map((node) => ({ id: node.id, ...sizes.get(node.id)! })), snapshot.edges)
  return new Map(snapshot.nodes.map(node => [node.id, drawn.get(node.id) ?? { position: placed.get(node.id)!, ...sizes.get(node.id)! }]))
}

export function runBoardCi(snapshot: AvailableRunBoardSnapshot, activity?: ActivitySnapshotV1) {
  const cis = new Map<string, CiActivity>()
  if (activity?.scope.kind !== 'workflow_run' || activity.scope.runId !== snapshot.runId
    || activity.scope.workspaceId !== snapshot.workspaceId || activity.scope.workflowId !== snapshot.workflowId
    || activity.scope.workflowVersionId !== snapshot.workflowVersionId) return cis
  const accept = (owner: WorkRef, ci: CiActivity) => {
    if (owner.kind !== 'ci' || owner.runId !== snapshot.runId || owner.ticketId !== ci.id
      || owner.workspaceId !== snapshot.workspaceId || owner.workflowId !== snapshot.workflowId
      || owner.workflowVersionId !== snapshot.workflowVersionId) return
    const node = snapshot.nodes.find(node => node.id === owner.nodeId)
    if (!node || node.kind === 'job' || node.agentId !== owner.agentId) return
    cis.set(node.id, ci)
  }
  for (const item of activity.activities) {
    if (item.kind === 'diagnostic' && item.ci) accept(item.owner, item.ci)
  }
  const priority = { queued: 0, starting: 1, running: 2, passed: -1, failed: -1, canceled: -1, lost: -1 }
  for (const work of [...activity.active].sort((a, b) => (a.ci ? priority[a.ci.state] : -1)
    - (b.ci ? priority[b.ci.state] : -1))) {
    if (work.ci) accept(work.ref, work.ci)
  }
  return cis
}

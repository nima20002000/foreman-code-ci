import { memo, useContext, useEffect, useMemo, useRef, useState } from 'react'
import { useQuery } from '@tanstack/react-query'
import { Background, Controls, Handle, Position, ReactFlow, ReactFlowProvider, type EdgeProps, type NodeProps } from '@xyflow/react'
import { AgentNodeView } from '../../shared/ui/nocturne/Canvas'
import { useReducedMotion } from '../../shared/ui/nocturne'
import type { ActivitySnapshotV1, Agent, WorkflowHierarchyReadResult } from '@foreman-code/contracts'
import type { WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { useGraphDraftStore } from '../graph/store'
import { nextDraftKey } from '../graph/nextDraft/state'
import { editorAgents } from '../graph/nextDraft/agentEdits'
import { CiServerNode, CiTransferEdge, type CiServerFlowNode, type CiTransferFlowEdge } from '../workflow-board/inspect/CiServer'
import { CI_SERVER_NODE_ID, ciJobRefreshing, ciNodeActivities, runCiApi } from '../workflow-board/inspect/ciServer'
import { useCiTransfers } from '../workflow-board/inspect/useCiTransfers'
import { runInspectionQueryKey } from '../workflow-board/inspect/queries'
import { useBoardCiServer } from '../workflow-board/inspect/useBoardCiServer'
import { BoardKanbanNode, KanbanActivityEdge, KANBAN_NODE_ID, type KanbanActivityFlowEdge, type KanbanFlowNode } from '../workflow-board/kanban/BoardKanban'
import { useBoardKanban } from '../workflow-board/kanban/useBoardKanban'
import { BoardDock } from '../workflow-board/dock/BoardDock'
import '../workflow-board/inspect/inspection.css'
import { ciNodePresentation } from './ciPresentation'
import { SignalEdgeShape } from '../graph/SignalEdgeShape'
import { useFloatingCurve } from '../graph/signalEdge'
import { RESPONSIVE_FIT_OPTIONS, RESPONSIVE_MIN_ZOOM, useResponsiveGraphViewport } from '../graph/useResponsiveGraphViewport'
import { boardViewportKey } from '../graph/boardViewport'
import { isRunAccessError } from '../runs-selector/query'
import { RunSubagentsOverlay } from '../run-subagents/RunSubagentsOverlay'
import { savedEdgeCurve } from './curve'
import { RunLiveNodes, useRunLiveNodes } from './useRunLiveNodes'
import { projectRunBoard, runBoardCi, READ_ONLY_FLOW_PROPS, type AvailableRunBoardSnapshot, type SavedBoardEdge, type SavedBoardNode } from './model'
import '@xyflow/react/dist/style.css'
import './runBoard.css'
import { useWorkflowBoard } from '../workflow-board/context'
import { useProtectedAccessError } from '../../shared/api/useProtectedAccessError'

const sides = [Position.Top, Position.Right, Position.Bottom, Position.Left] as const
const SavedAgent = memo(function SavedAgent({ id, data }: NodeProps<SavedBoardNode>) {
  const ci = data.ci
  // A live Run shows each node's turn, queue, CI wait or pending decision; otherwise the saved presentation.
  const live = useContext(RunLiveNodes)?.get(id)
  const presentation = live ?? (ci ? ciNodePresentation(ci) : { label: 'Saved', state: 'idle' as const })
  return <>
    {/* Keep the authoring button inert; inspection has its own accessible action. */}
    <div className="run-board-node-visual" aria-hidden="true" inert>
      <AgentNodeView className="run-board-agent" name={data.snapshot.name} harnessLabel=""
        statusLabel={presentation.label} state={presentation.state} transition={live?.transition} transitionKey={live?.transitionKey} />
    </div>
    {/* The whole node is the Inspect target, so no button covers the node's face. */}
    {data.inspect ? <button type="button" className="run-board-inspect nopan"
      aria-label={`Inspect ${data.snapshot.name}`} title={`Inspect ${data.snapshot.name}`} onClick={data.inspect} /> : null}
    {ci ? <span role="status">{ciNodePresentation(ci).label}</span> : null}
    {data.snapshot.kind !== 'job' && data.role ? <p className="run-board-node-caption">{data.role}{data.reportingParent ? ` · Reports to ${data.reportingParent}` : ''}</p> : null}
    {/* Unlike the authoring AgentHandles, every saved target side must resolve. */}
    {sides.flatMap((side) => (['source', 'target'] as const).map((type) =>
      <Handle key={`${type}:${side}`} id={side} type={type} position={side} isConnectable={false}
        className="run-board-handle" aria-hidden="true" />))}
  </>
})
const SavedConnection = memo(function SavedConnection(props: EdgeProps<SavedBoardEdge>) {
  const edge = props.data?.snapshot
  const bend = props.data?.bend ?? 0, loop = props.source === props.target
  const floating = useFloatingCurve(props.source, props.target, bend)
  if (!edge) return null
  // Same lines as the Board: straight when aligned, leaning toward the target otherwise; only a self-loop keeps its own loop.
  const curve = !loop && floating ? floating : savedEdgeCurve({ ...props, lane: bend / 44, loop })
  return <g>
    <title>{[edge.label || (props.data!.members.length > 1 ? 'Handoff · approval' : edge.kind === 'approval' ? 'Approval' : 'Handoff'),
      ...props.data!.members.filter(member => member.id !== edge.id).map(member => member.label)].filter(Boolean).join(' · ')}</title>
    <SignalEdgeShape id={props.id} curve={curve} kind={edge.kind} />
  </g>
})
const nodeTypes = { savedBoardNode: SavedAgent, ciServer: CiServerNode, boardKanban: BoardKanbanNode }
const edgeTypes = { savedBoardEdge: SavedConnection, ciTransfer: CiTransferEdge, kanbanActivity: KanbanActivityEdge }
// The draft Board's own zoom limits and fit, so the view behaves the same while a Run is shown.
const fitViewOptions = RESPONSIVE_FIT_OPTIONS
const proOptions = { hideAttribution: true }

const noAgents: readonly Agent[] = []
/** The draft Board's Agents (its mounted draft), so a Run's nodes get the same role sizes the draft shows. */
function useDraftBoardAgents(workspaceId: string, workflowId: string) {
  // Only names and roles size a node: other draft edits must not rebuild the Run's nodes.
  const roles = useGraphDraftStore(state => {
    const edit = state.nextDrafts[nextDraftKey(workspaceId, workflowId)]
    return edit ? JSON.stringify(editorAgents(edit).map(agent => [agent.id, agent.name, agent.productRole ?? null])) : ''
  })
  return useMemo(() => roles ? (JSON.parse(roles) as [string, string, Agent['productRole'] | null][])
    .map(([id, name, productRole]): Agent => ({ id, name, ...(productRole ? { productRole } : {}) })) : noAgents, [roles])
}

/** A private React Flow store, even when mounted beneath an editor's provider. */
export function RunBoardCanvas({ snapshot, activitySnapshot, onInspectNode, hierarchy, definition, visible = true }: {
  snapshot: AvailableRunBoardSnapshot; activitySnapshot?: ActivitySnapshotV1 | undefined
  onInspectNode?: (nodeId: string) => void
  hierarchy?: WorkflowHierarchyReadResult; definition?: WorkflowDefinitionV3; visible?: boolean
}) {
  const board = useWorkflowBoard()
  const { containerRef, onInit, onMove, onMoveEnd, onManualMove, refit, defaultViewport, fitOnMount } = useResponsiveGraphViewport<
    SavedBoardNode | CiServerFlowNode | KanbanFlowNode, SavedBoardEdge | CiTransferFlowEdge | KanbanActivityFlowEdge>({
    fitViewOptions, viewportKey: boardViewportKey(snapshot.workspaceId, snapshot.workflowId),
  })
  // Callers recreate their handler every render; reading it through a ref keeps unchanged nodes referentially stable.
  const inspectNode = useRef(onInspectNode)
  inspectNode.current = onInspectNode
  const inspectable = Boolean(onInspectNode)
  const agents = useDraftBoardAgents(snapshot.workspaceId, snapshot.workflowId)
  const draft = useGraphDraftStore(state => state.nextDrafts[nextDraftKey(snapshot.workspaceId, snapshot.workflowId)]?.graph)
  const { nodes, edges } = useMemo(() => {
    const projected = projectRunBoard(snapshot, activitySnapshot, hierarchy, { definition, draft, agents })
    if (inspectable) for (const node of projected.nodes) {
      node.data = { ...node.data, inspect: () => inspectNode.current?.(node.id) }
    }
    return projected
  }, [snapshot, activitySnapshot, inspectable, hierarchy, definition, draft, agents])
  // React Flow reconciles every node it is given; keep these arrays referentially stable between unrelated renders.
  const teamNodeId = board?.teamNodeId
  // Same rule as the draft Board: an agent the draft has can be dragged, and the drop is the draft's own layout change.
  const move = board?.moveDraftNodes
  const movable = useMemo(() => new Set(move ? (draft?.nodes ?? definition?.nodes ?? []).map(node => node.id) : []), [move, draft, definition])
  const [dragged, setDragged] = useState<Readonly<Record<string, { x: number; y: number }>>>({})
  useEffect(() => setDragged(previous => {
    // A drop the draft has taken is drawn from the draft again; one it has not stays where it was dropped.
    const kept = Object.entries(previous).filter(([id, place]) => {
      const shown = nodes.find(node => node.id === id)?.position
      return !shown || shown.x !== place.x || shown.y !== place.y
    })
    return kept.length === Object.keys(previous).length ? previous : Object.fromEntries(kept)
  }), [nodes])
  const visibleNodes = useMemo(() => nodes.map(node => ({ ...node, selected: teamNodeId === node.id,
    ...(movable.has(node.id) ? { draggable: true, position: dragged[node.id] ?? node.position } : {}) })), [nodes, teamNodeId, movable, dragged])
  const scope = useMemo(() => ({ workspaceId: snapshot.workspaceId, workflowId: snapshot.workflowId,
    runId: snapshot.runId, workflowVersionId: snapshot.workflowVersionId, executionSemanticsVersion: 3 as const }), [snapshot])
  const active = !activitySnapshot || activitySnapshot.active.length > 0
    || activitySnapshot.queued.length > 0 || activitySnapshot.hasMoreActiveWork === true
  const ciList = useQuery({
    queryKey: [...runInspectionQueryKey(scope), 'ci-jobs'],
    enabled: visible,
    queryFn: ({ signal }) => runCiApi.list({ workspaceId: scope.workspaceId, runId: scope.runId }, { signal }),
    refetchInterval: (query) => {
      if (!visible || isRunAccessError(query.state.error)) return false
      return active || query.state.data?.jobs.some(ciJobRefreshing) ? 1500 : false
    },
  })
  // A denied read must not leave authorized-looking jobs behind; any other failure keeps the last jobs read.
  const ciDenied = useProtectedAccessError(ciList)
  const names = useMemo(() => new Map(snapshot.nodes.map((node) => [node.id, node.name])), [snapshot.nodes])
  const towerNodes = useMemo(() => nodes.map((node) => ({ position: node.position, width: node.initialWidth, height: node.initialHeight })), [nodes])
  const ci = useBoardCiServer({ nodes: towerNodes, names, scope, workflow: { workspaceId: scope.workspaceId, workflowId: scope.workflowId },
    jobs: !ciDenied && ciList.data?.runId === scope.runId ? ciList.data.jobs : undefined,
    truncated: !ciDenied && (ciList.data?.truncated ?? false), error: Boolean(ciDenied) || ciList.isError, loading: ciList.isPending })
  // The workflow's Kanban sits on its Board in every view, so Agents' card changes show live during the Run.
  const shownIds = useMemo(() => new Set(visibleNodes.map(node => node.id)), [visibleNodes])
  const kanban = useBoardKanban({ workspaceId: snapshot.workspaceId, workflowId: snapshot.workflowId, nodes: towerNodes,
    nodeIds: shownIds, enabled: !!board })
  // The Kanban arrives after the first fit; fit once more so it is not left off-screen (as on the draft Board).
  const kanbanShown = !!kanban.node
  useEffect(() => {
    if (!kanbanShown) return
    const frame = requestAnimationFrame(refit)
    return () => cancelAnimationFrame(frame)
  }, [kanbanShown, refit])
  const flowNodes = useMemo<(SavedBoardNode | CiServerFlowNode | KanbanFlowNode)[]>(() =>
    [...visibleNodes, ...(kanban.node ? [kanban.node] : []), ...(ci.node ? [ci.node] : [])], [visibleNodes, ci.node, kanban.node])
  const ciJobs = !ciDenied && !ciList.isError && ciList.data?.runId === scope.runId ? ciList.data.jobs : undefined
  // A node waits on its newest unfinished CI from either the Run's Activity or the CI server's own list.
  const cis = useMemo(() => new Map([...runBoardCi(snapshot, activitySnapshot), ...ciNodeActivities(ciJobs ?? [])]),
    [snapshot, activitySnapshot, ciJobs])
  // Live node words belong to the mounted Board; a standalone saved Run Board reads only its saved Run.
  const liveNodes = useRunLiveNodes(scope, names, cis, visible && !!board)
  // A light per Agent while its CI request or result travels; no lasting line to the server.
  const transfers = useCiTransfers(ciJobs, useReducedMotion())
  const ciEdges = useMemo<(SavedBoardEdge | CiTransferFlowEdge)[]>(() => ci.node && transfers.size ? [...edges,
    ...[...transfers].filter(([nodeId]) => visibleNodes.some(node => node.id === nodeId)).map(([nodeId, pulses]) => ({
      id: `ci-transfer:${nodeId}`, type: 'ciTransfer' as const, source: nodeId, target: CI_SERVER_NODE_ID,
      sourceHandle: 'right', targetHandle: 'left', selectable: false, focusable: false, deletable: false, data: { pulses } }))]
    : edges, [edges, visibleNodes, transfers, ci.node])
  const flowEdges = useMemo<(SavedBoardEdge | CiTransferFlowEdge | KanbanActivityFlowEdge)[]>(() => kanban.edges.length
    ? [...ciEdges, ...kanban.edges] : ciEdges, [ciEdges, kanban.edges])
  return <div ref={containerRef} className="run-board-canvas" data-testid="run-board-canvas" onKeyDown={(event) => {
    // History keystrokes must not bubble into an ancestor's authoring shortcuts.
    event.stopPropagation()
    const editing = event.target instanceof HTMLElement && event.target.closest('input,textarea,[contenteditable="true"]')
    if ((!editing && (event.key === 'Delete' || event.key === 'Backspace'))
      || ((event.ctrlKey || event.metaKey) && event.key.toLowerCase() === 's')) event.preventDefault()
  }}>
    <ReactFlowProvider><RunLiveNodes.Provider value={liveNodes}>
      <ReactFlow<SavedBoardNode | CiServerFlowNode | KanbanFlowNode, SavedBoardEdge | CiTransferFlowEdge | KanbanActivityFlowEdge> nodes={flowNodes} edges={flowEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        {...READ_ONLY_FLOW_PROPS} onNodesChange={(changes) => {
          kanban.applyChanges(changes); ci.place.applyChanges(changes)
          const moves = changes.flatMap(change => change.type === 'position' && change.position && movable.has(change.id) ? [[change.id, change.position] as const] : [])
          if (moves.length) setDragged(previous => ({ ...previous, ...Object.fromEntries(moves) }))
        }}
        onNodeDragStop={(_event, node) => {
          if (node.id === KANBAN_NODE_ID) kanban.moved(node.position)
          if (node.id === CI_SERVER_NODE_ID) ci.place.moved(node.position)
          if (movable.has(node.id)) move?.([{ id: node.id, position: { x: node.position.x, y: node.position.y } }])
        }} fitView={fitOnMount} defaultViewport={defaultViewport} fitViewOptions={fitViewOptions} minZoom={RESPONSIVE_MIN_ZOOM} maxZoom={1.6}
        onInit={onInit} onMove={onMove} onMoveEnd={onMoveEnd}
        proOptions={proOptions} aria-label="Saved Run graph"
        ariaLabelConfig={{ 'node.a11yDescription.default': 'Saved agent, read only.', 'edge.a11yDescription.default': 'Saved connection, read only.' }}>
        <RunSubagentsOverlay scope={snapshot} nodes={snapshot.nodes} visible={visible} />
        <Background color="var(--border)" gap={24} size={1} />
        <Controls showInteractive={false} fitViewOptions={fitViewOptions} aria-label="Run view controls"
          onZoomIn={onManualMove} onZoomOut={onManualMove} />
      </ReactFlow>
    </RunLiveNodes.Provider></ReactFlowProvider>
    {visible ? ci.dialog : null}
    <BoardDock kanban={kanban.dock} ci={ci.node ? undefined : { summary: ci.summary, restore: ci.place.restore }} />
  </div>
}

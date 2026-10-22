import { useHoverControls } from '../../../shared/ui/useHoverControls'
import type { JobWorkflowAdmissionReference } from '@foreman-code/contracts/job-workflow'
import { createContext, forwardRef, memo, useCallback, useContext, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useState, type ReactNode } from 'react'
import { Background, ConnectionMode, ReactFlow, type Edge, type EdgeProps, type NodeChange, type NodeProps } from '@xyflow/react'
import { WorkflowRelationshipSchema, type WorkflowDefinitionV3, type WorkflowRelationship } from '@foreman-code/contracts/wave25'
import { isHierarchyReportingRoute, type Agent } from '@foreman-code/contracts'
import { AgentNodeView, IconButton, Icon, type AgentPanel } from '../../../shared/ui/nocturne'
import { createGraphTopologyProjector } from '../topology'
import { GRAPH_NODE_DEFAULT_SIZE } from '../mapper'
import { createGraphGeometryAdapter, type GraphGeometryChange } from '../geometry'
import { CircularNodeResizer } from '../CircularNodeResizer'
import { useGraphDraftStore } from '../store'
import { useGraphPresentation, useGraphPresentationStore } from '../useGraphPresentation'
import { AgentHandles } from '../AgentHandles'
import { intervalLabel } from './intervalLabel'
import { agentNodeFacts, edgeBend, relationshipLines, useFloatingCurve } from '../signalEdge'
import { SignalEdgeShape } from '../SignalEdgeShape'
import { RESPONSIVE_FIT_OPTIONS, RESPONSIVE_MIN_ZOOM, useResponsiveGraphViewport } from '../useResponsiveGraphViewport'
import type { GraphNode, AgentGraphNode, JobGraphNode } from '../types'
import { nodeTitle, putRelationship, removeRelationship, setWorkConnectionLimit } from './model'
import { pinGraphLayout } from './placement'
import { WorkConnectionLimitEditor } from './WorkConnectionLimitEditor'
import type { EditGraph } from './AuthoringFields'
import { useWorkflowBoard } from '../../workflow-board/context'
import { WorkflowAgentPanel } from '../../workflow-board/WorkflowAgentPanel'
import { SelectedRunCanvas } from '../../workflow-board/inspect/SelectedRunCanvas'
import { CiServerNode, type CiServerFlowNode } from '../../workflow-board/inspect/CiServer'
import { CI_SERVER_NODE_ID } from '../../workflow-board/inspect/ciServer'
import { useBoardCiServer } from '../../workflow-board/inspect/useBoardCiServer'
import { BoardKanbanNode, KanbanActivityEdge, KANBAN_NODE_ID, type KanbanActivityFlowEdge, type KanbanFlowNode } from '../../workflow-board/kanban/BoardKanban'
import { useBoardKanban } from '../../workflow-board/kanban/useBoardKanban'
import { BoardDock } from '../../workflow-board/dock/BoardDock'
import { connectHierarchyMember } from '../../workflow-hierarchy/authoring'
import { useAgentProximity } from '../useAgentProximity'
import '@xyflow/react/dist/style.css'

export type OpenAgentPanel = { nodeId: string; panel: AgentPanel }
export type AgentPanels = { chatHasHeader?: boolean; chat: ReactNode; settings: ReactNode; info: ReactNode }
/** A selected Run supplies its pinned identity, including nodes no longer present in the draft. */
export type PinnedPanelNode = {kind?:'agent';agentId:string;name:string;role?:string;runLabel?:string;reportingParent?:string}|{kind:'job';jobDefinitionId:string;jobDefinitionRevision:number;jobDefinitionVersionId:string;name:string;workflowExecution?:JobWorkflowAdmissionReference}
export type AgentPanelRenderer = (nodeId: string, pinned?: PinnedPanelNode) => AgentPanels
type Canvas = {
  draftKey: string
  inspect: (action: () => void) => void
  open?: OpenAgentPanel
  setOpen: (next?: OpenAgentPanel) => void
  openChat?: (nodeId: string) => void
  selectNode?: (nodeId: string) => void
  beginResize?: () => void
  resize?: (change: GraphGeometryChange) => void
  finishResize?: (id: string, width: number, height: number, position?: { x: number; y: number }) => void
  /** Agents whose current settings are newer than the saved workflow's pins. */
  changedAgentIds?: readonly string[]
}
const CanvasContext = createContext<Canvas>({ draftKey: '', inspect: (action) => action(), setOpen: () => undefined })

const DraftAgent = memo(function DraftAgent({ id, data, selected, width, height }: NodeProps<AgentGraphNode>) {
  const { draftKey, inspect, open, setOpen, openChat, selectNode, beginResize, resize, finishResize, changedAgentIds } = useContext(CanvasContext)
  const entry = useGraphDraftStore((state) => state.nextDrafts[draftKey]?.graph.entryNodeId === id)
  const presentation = useGraphPresentationStore()
  const run = { label: changedAgentIds?.includes(data.agent.id) ? 'Settings changed' : 'Draft', state: 'idle' as const }
  const facts = agentNodeFacts(data.agent)
  const meta = data.intervalSeconds ? [{ label: 'Loop', value: intervalLabel(data.intervalSeconds) }, ...facts.meta].slice(0, 2) : facts.meta
  const panel = open?.nodeId === id ? open.panel : undefined
  const select = () => inspect(() => { presentation.getState().setFocusedNodeId(id); presentation.getState().setFocusedEdgeId(undefined) })
  return <AgentNodeView name={data.label} harness={facts.harness} harnessLabel={facts.harnessLabel} model={facts.model}
    icon={facts.icon} statusLabel={run.label} state={run.state} meta={meta} entry={entry} selected={selected} openPanel={panel}
    ariaLabel={`${data.label}, ${facts.roleLabel}${entry ? ', starts the workflow' : ''}, ${facts.harnessLabel}, ${run.label}`}
    onSelect={(event) => { event.stopPropagation(); if (selectNode) selectNode(id); else select() }}
    onAction={(next) => inspect(() => {
      presentation.getState().setFocusedNodeId(id); presentation.getState().setFocusedEdgeId(undefined)
      if (next === 'chat') openChat?.(id)
      else setOpen(panel === next ? undefined : { nodeId: id, panel: next })
    })}>
    <AgentHandles name={data.label} />
    <CircularNodeResizer id={id} name={data.label} width={width ?? GRAPH_NODE_DEFAULT_SIZE} height={height ?? GRAPH_NODE_DEFAULT_SIZE}
      onStart={beginResize} onResize={resize}
      onFinish={(change) => finishResize?.(id, change.width!, change.height!, change.position)} />
  </AgentNodeView>
})

type DraftEdge = Edge<{ kind: WorkflowRelationship['kind']; bend: number;
  remove: () => void; removeLabel: string; removalDisabled: boolean;
  workPolicy: boolean; maxWorkHandoffsPerRun?: number; draftChanged: boolean; disabled: boolean;
  onApplyLimit?: (value?: number) => void }>
const TypedEdge = memo(function TypedEdge({ id, source, target, data, selected }: EdgeProps<DraftEdge>) {
  const curve = useFloatingCurve(source, target, data?.bend ?? 0)
  const { hovered, onPointerEnter, onPointerLeave } = useHoverControls()
  const [editing, setEditing] = useState(false)
  const [focused, setFocused] = useState(false)
  const visible = hovered || focused || selected
  if (!curve) return null
  const limit = data?.maxWorkHandoffsPerRun
  return <g onPointerEnter={onPointerEnter} onPointerLeave={onPointerLeave}
    onFocus={() => setFocused(true)} onBlur={event => {
      if (!event.currentTarget.contains(event.relatedTarget as globalThis.Node | null)) setFocused(false)
    }}>
    <SignalEdgeShape id={id} curve={curve} kind={data?.kind} />
    {visible ? <rect className="board-edge-hover-bridge" x={curve.mid.x - 18} y={curve.mid.y - 36}
      width={36} height={48} /> : null}
    <foreignObject data-visible={visible} className="board-edge-remove nodrag nopan" x={curve.mid.x - 18} y={curve.mid.y - 36} width={36} height={36}>
      <IconButton size="sm" variant="ghost" label={data?.removeLabel ?? `Remove connection from ${source} to ${target}`}
        tabIndex={0} disabled={data?.removalDisabled} onClick={(event) => { event.stopPropagation(); data?.remove() }}><Icon name="close" size={14} /></IconButton>
    </foreignObject>
    {data?.workPolicy ? <foreignObject className="work-connection-limit-object" data-visible={hovered || editing}
      x={curve.mid.x - (editing ? 132 : 54)} y={curve.mid.y + 12}
      width={editing ? 264 : 108} height={editing ? 208 : 42}>
      <div className="work-connection-limit-control nodrag nopan nowheel"
        onPointerDown={(event) => event.stopPropagation()} onClick={(event) => event.stopPropagation()}>
        {editing ? <WorkConnectionLimitEditor compact value={limit} disabled={data.disabled}
          onCancel={() => setEditing(false)} onApply={(value) => { data.onApplyLimit?.(value); setEditing(false) }} />
          : <button type="button" className="work-connection-limit-pill" data-testid={`work-limit-${id}`}
            disabled={data.disabled} title="Edit the work handoff limit on this connection"
            aria-label={`Maximum work handoffs per Run: ${limit ?? 'unlimited'}${data.draftChanged ? ', draft change' : ''}. Edit connection limit.`}
            onClick={(event) => { event.stopPropagation(); setEditing(true) }}>
            <span>{limit ?? '∞'}</span>{data.draftChanged ? <small>Draft</small> : null}
          </button>}
      </div>
    </foreignObject> : null}
  </g>
})
const DraftJob=memo(function DraftJob({id,data,selected}:NodeProps<JobGraphNode>) {
  const {draftKey,inspect,open,setOpen,selectNode}=useContext(CanvasContext)
  const entry=useGraphDraftStore(state=>state.nextDrafts[draftKey]?.graph.entryNodeId===id)
  const panel=open?.nodeId===id?open.panel:undefined
  return <AgentNodeView name={data.label} harnessLabel="Job" statusLabel="Saved job" selected={selected} entry={entry} openPanel={panel}
    ariaLabel={`${data.label}, job, saved revision ${data.jobDefinitionRevision}`}
    onSelect={(event)=>{event.stopPropagation();inspect(()=>{selectNode?.(id);setOpen({nodeId:id,panel:'info'})})}}
><AgentHandles name={data.label}/></AgentNodeView>
})
const nodeTypes = { agent: DraftAgent, job: DraftJob, ciServer: CiServerNode, boardKanban: BoardKanbanNode }
const edgeTypes = { typed: TypedEdge, kanbanActivity: KanbanActivityEdge }
const noNames: ReadonlyMap<string, string> = new Map()
const fitViewOptions = RESPONSIVE_FIT_OPTIONS
const proOptions = { hideAttribution: true }
export type DraftCanvasHandle = { flush(): void; cancel(): void }

/** The draft remains mounted with its geometry buffer while the selected Run
 * renders its immutable topology. Hidden draft nodes do not subscribe to live
 * Run state or repeatedly scan execution history. */
export const DraftCanvas = forwardRef<DraftCanvasHandle, {
  draftKey: string; graph: WorkflowDefinitionV3; agents: readonly Agent[]; kind: WorkflowRelationship['kind']
  baseGraph?: WorkflowDefinitionV3; semanticLocked?: boolean
  change: EditGraph; geometry: (changes: GraphGeometryChange[]) => void; pending: (pending: boolean) => void
  report: (error: unknown) => void; inspect?: (action: () => void) => void; removalDisabled?: boolean
  open?: OpenAgentPanel; setOpen?: (next?: OpenAgentPanel) => void; panels?: AgentPanelRenderer
  changedAgentIds?: readonly string[]
  children?: ReactNode
}>(function DraftCanvas({ draftKey, graph, agents, kind, baseGraph, semanticLocked = false, changedAgentIds,
  change, geometry, pending, report, inspect = (action) => action(), removalDisabled = false,
  open, setOpen = () => undefined, panels = () => ({ chat: null, settings: null, info: null }), children }, ref) {
  const board = useWorkflowBoard()
  const selectedRun = board?.run
  const responsive = useResponsiveGraphViewport<GraphNode | CiServerFlowNode | KanbanFlowNode, DraftEdge | KanbanActivityFlowEdge>({ enabled: !selectedRun })
  const [project] = useState(() => createGraphTopologyProjector())
  const topology = useMemo(() => project(graph, agents), [project, graph, agents])
  const [adapter] = useState(() => createGraphGeometryAdapter(topology.nodes))
  const [nodes, setNodes] = useState(topology.nodes)
  const [connecting, setConnecting] = useState(false)
  // Every Board shows the CI server automatically; it is never a workflow node and cannot be added by hand.
  const ci = useBoardCiServer({ nodes, names: noNames, workflow: { workspaceId: graph.workspaceId, workflowId: graph.id }, keepPlace: true })
  const teamNodeId = board?.teamNodeId
  const shownIds = useMemo(() => new Set(nodes.map(node => node.id)), [nodes])
  const kanban = useBoardKanban({ workspaceId: graph.workspaceId, workflowId: graph.id, nodes, nodeIds: shownIds, enabled: !!board })
  const kanbanShown = !!kanban.node, refit = responsive.refit
  const proximity = useAgentProximity()
  useEffect(() => {
    if (!kanbanShown) return
    const frame = requestAnimationFrame(refit)
    return () => cancelAnimationFrame(frame)
  }, [kanbanShown, refit])
  const flowNodes = useMemo<(GraphNode | CiServerFlowNode | KanbanFlowNode)[]>(() => [...nodes.map(node =>
    teamNodeId === node.id ? { ...node, selected: true } : node), ...(kanban.node ? [kanban.node] : []), ...(ci.node ? [ci.node] : [])],
  [nodes, teamNodeId, ci.node, kanban.node])
  const selectedIds = useGraphPresentation((state) => state.selectedNodeIds)
  const presentation = useGraphPresentationStore()
  useLayoutEffect(() => { setNodes(adapter.reconcile(topology.nodes, selectedIds)) }, [adapter, topology.nodes, selectedIds])
  const flush = () => {
    const changes = adapter.flush()
    if (changes.length) geometry(changes)
    pending(false)
  }
  const prepareResize = () => {
    setConnecting(false)
  }
  const beginResize = () => {
    prepareResize()
    adapter.beginResize()
  }
  const finishResize = (id: string, width: number, height: number, position?: { x: number; y: number }) => {
    setNodes(adapter.finishResize(id, width, height, position))
    flush()
  }
  useImperativeHandle(ref, () => ({ flush, cancel: () => { setNodes(adapter.cancel()); pending(false) } }))
  const edges = useMemo<DraftEdge[]>(() => {
    const counts = new Map<string, number>()
    // One line per agent pair: an approval beside a handoff is drawn on the handoff's line.
    return relationshipLines(graph.edges).lines.map(({ members, ...edge }) => {
      const pair = JSON.stringify([edge.source, edge.target].sort()), count = counts.get(pair) ?? 0
      counts.set(pair, count + 1)
      // Before a Master exists, an Orchestrator's line to a Worker is still that Worker's team line.
      const role = (id: string) => { const node = graph.nodes.find(item => item.id === id)
        return node && node.kind !== 'job' ? agents.find(agent => agent.id === node.agentId)?.productRole : undefined }
      const reporting = isHierarchyReportingRoute(graph.hierarchy, edge)
        || !graph.hierarchy && edge.kind === 'execution' && role(edge.source) === 'orchestrator' && role(edge.target) === 'coder'
      const workLabel = reporting ? 'Orchestrates' : 'Handoff'
      const kindLabel = members.length > 1 ? `${workLabel} · approval` : edge.kind === 'approval' ? 'Approval' : workLabel
      return { ...edge, type: 'typed', sourceHandle: 'right', targetHandle: 'left',
        ariaLabel: `${kindLabel} from ${nodeTitle(graph, edge.source)} to ${nodeTitle(graph, edge.target)}${edge.label ? `: ${edge.label}` : ''}`,
        data: { kind: edge.kind, bend: edgeBend(count, edge.source < edge.target),
          remove: () => change((value) => removeRelationship(value, edge.id)),
          removeLabel: `Remove ${edge.kind === 'approval' ? 'approval' : 'handoff'} from ${nodeTitle(graph, edge.source)} to ${nodeTitle(graph, edge.target)}`,
          removalDisabled, workPolicy: Boolean(graph.handoffs && edge.kind === 'execution'),
          maxWorkHandoffsPerRun: edge.maxWorkHandoffsPerRun,
          draftChanged: edge.maxWorkHandoffsPerRun !== baseGraph?.edges.find((item) => item.id === edge.id)?.maxWorkHandoffsPerRun,
          disabled: semanticLocked,
          onApplyLimit: (limit?: number) => {
            try { change((value) => setWorkConnectionLimit(value, edge.id, limit)) }
            catch (error) { report(error) }
          } } }
    })
  }, [graph, agents, baseGraph, semanticLocked, change, report, removalDisabled])
  const visibleEdges = useMemo<(DraftEdge | KanbanActivityFlowEdge)[]>(() => [...edges, ...kanban.edges], [edges, kanban.edges])
  const roleOf = (nodeId: string) => {
    const node = graph.nodes.find(item => item.id === nodeId)
    return node && node.kind !== 'job' ? agents.find(agent => agent.id === node.agentId)?.productRole : undefined
  }
  // Who moves along: the members reporting to a node; without a Master, Workers connected to an Orchestrator.
  const followersOf = (parent: string): string[] => graph.hierarchy
    ? graph.hierarchy.parents.filter(member => member.parentNodeId === parent).map(member => member.workflowNodeId)
    : roleOf(parent) !== 'orchestrator' ? [] : graph.edges.filter(edge => edge.kind === 'execution' && (edge.source === parent || edge.target === parent))
      .map(edge => edge.source === parent ? edge.target : edge.source).filter(id => roleOf(id) === 'coder')
  /** Moving an Orchestrator (or the Master) moves its team by the same distance, in the same gesture. */
  const withFollowers = (changes: NodeChange<GraphNode>[]): NodeChange<GraphNode>[] => {
    const moving = new Set(changes.flatMap(change => change.type === 'position' ? [change.id] : []))
    const extra: NodeChange<GraphNode>[] = []
    for (const change of changes) {
      if (change.type !== 'position') continue
      const leader = nodes.find(node => node.id === change.id)
      if (!leader) continue
      const delta = change.position ? { x: change.position.x - leader.position.x, y: change.position.y - leader.position.y } : undefined
      const pending = followersOf(change.id), seen = new Set<string>()
      while (pending.length) {
        const id = pending.pop()!
        if (seen.has(id) || moving.has(id)) continue
        seen.add(id); pending.push(...followersOf(id))
        const follower = nodes.find(node => node.id === id)
        if (!follower) continue
        extra.push({ type: 'position', id, ...(change.dragging === undefined ? {} : { dragging: change.dragging }),
          ...(delta ? { position: { x: follower.position.x + delta.x, y: follower.position.y + delta.y } } : {}) })
      }
    }
    return extra.length ? [...changes, ...extra] : changes
  }
  const onNodesChange = (allChanges: NodeChange<GraphNode | CiServerFlowNode | KanbanFlowNode>[]) => {
    kanban.applyChanges(allChanges)
    ci.place.applyChanges(allChanges)
    const changes = allChanges.filter((item): item is NodeChange<GraphNode> => !('id' in item)
      || (item.id !== CI_SERVER_NODE_ID && item.id !== KANBAN_NODE_ID))
    const nextSelection = new Set(presentation.getState().selectedNodeIds)
    for (const item of changes) if (item.type === 'select') {
      if (item.selected) nextSelection.add(item.id); else nextSelection.delete(item.id)
    }
    presentation.getState().setSelectedNodeIds(nextSelection)
    const result = adapter.update(withFollowers(changes))
    setNodes(result.nodes); pending(result.pending)
    if (result.finished) flush()
  }
  const connectNodes = (first: string, second: string) => {
    const roles = new Map(graph.nodes.map(node => [node.id, node.kind === 'job' ? undefined
      : agents.find(agent => agent.id === node.agentId)?.productRole]))
    // Without a Master yet, a line between an Orchestrator and a Worker still runs from the Orchestrator down.
    const rank = (id: string) => ({ master: 0, orchestrator: 1, coder: 2 } as Record<string, number>)[roles.get(id) ?? ''] ?? -1
    const [source, target] = !graph.hierarchy && rank(first) >= 0 && rank(second) >= 0 && rank(second) < rank(first) ? [second, first] : [first, second]
    try { change((value) => {
      // A new line never re-lays out the Board: every node keeps the place it is shown at.
      const base = pinGraphLayout(value, agents)
      const next = connectHierarchyMember(base, roles, source, target)
        ?? (base.edges.some((edge) => edge.kind === kind && edge.source === source && edge.target === target) ? base
          : putRelationship(base, WorkflowRelationshipSchema.parse({ id: `relationship-${crypto.randomUUID()}`, kind, source, target })))
      return next === base ? value : next
    }) }
    catch (error) { report(error) }
  }
  const selectNode = (nodeId: string) => inspect(() => {
    presentation.getState().setFocusedNodeId(nodeId)
    presentation.getState().setSelectedNodeIds(new Set([nodeId]))
    presentation.getState().setFocusedEdgeId(undefined)
  })
  const resize = (change: GraphGeometryChange) => {
    const result = adapter.update([
      { id: change.id, type: 'dimensions', dimensions: { width: change.width!, height: change.height! }, resizing: true },
      { id: change.id, type: 'position', position: change.position },
    ])
    setNodes(result.nodes)
    pending(result.pending)
  }
  const selectSidePanel = board?.selectSidePanel
  const openChat = useCallback((nodeId: string) => {
    selectSidePanel?.({ kind: 'agent', nodeId, tab: 'chat' })
  }, [selectSidePanel])
  // Other code asks for a node's chat through the single open-panel state; chat opens in the Board side panel.
  useEffect(() => { if (open?.panel === 'chat') { openChat(open.nodeId); setOpen(undefined) } }, [open, openChat, setOpen])
  const docked = board?.sidePanel?.kind === 'agent' ? board.sidePanel : undefined
  const shown = docked ? { nodeId: docked.nodeId, panel: docked.tab === 'details' ? 'info' as const : docked.tab } : undefined
  const setPanel = (next?: OpenAgentPanel) => {
    if (board?.selectSidePanel) board.selectSidePanel(next
      ? { kind: 'agent', nodeId: next.nodeId, tab: next.panel === 'info' ? 'details' : next.panel } : { kind: 'none' })
    else setOpen(next)
  }
  const context = { draftKey, inspect, open: board?.selectSidePanel ? shown : open, setOpen: setPanel, openChat, selectNode, beginResize, resize, finishResize, changedAgentIds }
  return <CanvasContext.Provider value={context}>
    <div ref={responsive.containerRef} {...proximity} className={`next-draft-canvas board-draft-canvas${connecting ? ' is-connecting' : ''}`} style={selectedRun ? { display: 'none' } : undefined} aria-hidden={!!selectedRun} inert={!!selectedRun} aria-label="Editable workflow graph">
      {/* While a Run is shown, the draft's data stays mounted but its flow does not: a hidden
          flow measures a zero-size box and would come back empty on Return to draft. */}
      {selectedRun ? null : <ReactFlow<GraphNode | CiServerFlowNode | KanbanFlowNode, DraftEdge | KanbanActivityFlowEdge> nodes={flowNodes}
        edges={visibleEdges} nodeTypes={nodeTypes} edgeTypes={edgeTypes}
        onNodesChange={onNodesChange} onNodeDragStop={(_event, node) => {
          if (node.id === KANBAN_NODE_ID) kanban.moved(node.position)
          if (node.id === CI_SERVER_NODE_ID) ci.place.moved(node.position)
        }}
        connectionMode={ConnectionMode.Loose} connectionRadius={120} deleteKeyCode={null}
        fitView fitViewOptions={fitViewOptions} proOptions={proOptions} minZoom={RESPONSIVE_MIN_ZOOM} maxZoom={1.6} onInit={responsive.onInit}
        onMove={responsive.onMove}
        isValidConnection={(connection) => connection.source !== connection.target}
        onConnectStart={() => setConnecting(true)} onConnectEnd={() => setConnecting(false)}
        onClickConnectStart={() => setConnecting(true)} onClickConnectEnd={() => setConnecting(false)}
        onNodeClick={(event, node) => {
          if (event.target instanceof Element && event.target.closest('.react-flow__handle')) return
          if (node.type !== 'ciServer' && node.type !== 'boardKanban') selectNode(node.id)
        }}
        onPaneClick={() => inspect(() => { setOpen(undefined); presentation.getState().setFocusedNodeId(undefined); presentation.getState().setFocusedEdgeId(undefined) })}
        onConnect={(connection) => {
          connectNodes(connection.source, connection.target)
        }}>
        <Background color="var(--border)" gap={24} size={1} />
      </ReactFlow>}
      {children}
      {selectedRun ? null : <BoardDock kanban={kanban.dock}
        ci={ci.node ? undefined : { summary: ci.summary, restore: ci.place.restore }} />}
      <WorkflowAgentPanel panels={panels} active={!selectedRun && board?.authoringActive !== false}
        findNode={nodeId => graph.nodes.some(node => node.id === nodeId) ? undefined : false} />
    </div>
    {selectedRun || board?.canvasVisible === false || board?.authoringActive === false || board?.memoryOpen ? null : ci.dialog}
    {selectedRun ? <SelectedRunCanvas key={JSON.stringify(selectedRun)} scope={selectedRun} panels={panels} layout={topology.nodes} geometry={geometry} /> : null}
  </CanvasContext.Provider>
})

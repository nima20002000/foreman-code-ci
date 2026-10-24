import { memo, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { Handle, NodeResizer, Position, type Edge, type EdgeProps, type Node, type NodeProps } from '@xyflow/react'
import { type MemoryBoardScope, type MemoryCard as Card, type WorkflowKanbanFrame } from '@foreman-code/contracts'
import { Button, Icon } from '../../../shared/ui/nocturne'
import '../dock/boardDock.css'
import { useManagedWorkflowQuery } from '../../../shared/api/query'
import {
  MemoryCard, createMemoryBoardClient, mergedMemoryItems, useMemoryBoard, useMemoryCards, errorMessage,
  statusLabels, type MemoryBoardView, type MemoryChange, type MemoryNodeOption,
} from '../../memory-boards'
import { PulseFlight, type EdgePulse } from '../../graph/SignalEdgeShape'
import { useFloatingCurve, useBoardSelection } from '../../board-core'
import { kanbanScope, reportKanbanActivity, useKanbanActivity, type KanbanCardActivity } from './kanbanActivity'
import { KanbanCardDialog } from './KanbanCardDialog'
import './boardKanban.css'

const client = createMemoryBoardClient()
export const KANBAN_NODE_ID = 'board-kanban'
const KANBAN_MIN = { width: 240, height: 160 }

export type KanbanFlowNode = Node<{ workspaceId: string; workflowId: string; saveError?: string
  resized(frame: WorkflowKanbanFrame): void; close(): void }, 'boardKanban'>

/** The workflow's memory board as one Board object: drag it by its bar, resize it from its edges, close it into
 * the dock with its X. Each card inside is its own element and shows an Agent's change live. */
export const BoardKanbanNode = memo(function BoardKanbanNode({ data }: NodeProps<KanbanFlowNode>) {
  const board = useBoardSelection()
  return <section className="board-kanban" aria-label="Kanban">
    <NodeResizer minWidth={KANBAN_MIN.width} minHeight={KANBAN_MIN.height} handleClassName="board-kanban-resize"
      onResizeEnd={(_event, frame) => data.resized(frame)} />
    <header className="board-kanban-bar" title="Drag to move the Kanban">
      <h2><Icon name="grid" size={14} />Kanban</h2>
      {board?.openMemoryCard ? <Button size="sm" variant="ghost" className="nodrag nopan"
        onClick={() => board.openMemoryCard?.()}>Open memory board</Button> : null}
      {data.saveError ? <span className="board-kanban-error" role="alert">Layout not saved: {data.saveError}</span> : null}
      <button type="button" className="board-object-close nodrag nopan" aria-label="Close Kanban to the dock" title="Close to the dock"
        onClick={data.close}><Icon name="close" size={14} /></button>
    </header>
    <div className="board-kanban-body nodrag nopan nowheel">
      <KanbanColumns workspaceId={data.workspaceId} workflowId={data.workflowId} />
    </div>
    {/* Only for the passing lights from Agents; nothing connects to the Kanban. */}
    <Handle id="left" type="target" position={Position.Left} isConnectable={false} className="board-kanban-target" />
  </section>
})

function KanbanColumns({ workspaceId, workflowId }: { workspaceId: string; workflowId: string }) {
  const board = useBoardSelection()
  const scope = useMemo<MemoryBoardScope>(() => ({ kind: 'workflow', workspaceId, workflowId }), [workspaceId, workflowId])
  const workflow = useManagedWorkflowQuery(workspaceId, workflowId)
  const graphNodes = useMemo(() => (workflow.data?.workflow.nodes ?? []).flatMap(node => node.kind === 'job' ? []
    : [{ id: node.id, agentId: node.agentId, label: node.name ?? node.label ?? node.id }]), [workflow.data])
  const nodes = useMemo<MemoryNodeOption[]>(() => graphNodes.map(node => ({ label: node.label, available: true, currentWork: [],
    node: { workspaceId, workflowId, workflowNodeId: node.id, agentId: node.agentId } })), [graphNodes, workspaceId, workflowId])
  const known = useRef(graphNodes)
  known.current = graphNodes
  const activityScope = kanbanScope(workspaceId, workflowId)
  const changed = useCallback((change: MemoryChange) => reportKanbanActivity(activityScope, change, known.current), [activityScope])
  const live = useMemoryBoard(client, scope, changed)
  const view = live.snapshot.data, error = live.identity.error ?? live.snapshot.error
  const activity = useKanbanActivity((state) => state.items[activityScope])
  const byCard = useMemo(() => new Map((activity ?? []).map((item) => [item.cardId, item])), [activity])
  // One message and one retry for every column that failed to read, instead of one per column.
  const [failed, setFailed] = useState<Partial<Record<Card['status'], () => void>>>({})
  const reportFailure = useCallback((status: Card['status'], retry?: () => void) => setFailed((previous) => {
    if (!!previous[status] === !!retry) return previous
    const next = { ...previous }
    if (retry) next[status] = retry
    else delete next[status]
    return next
  }), [])
  const retries = Object.values(failed)
  // A clicked card opens in its own window on any Board; editing stays in the memory board.
  const [openCard, setOpenCard] = useState<string>()
  const editCard = board?.openMemoryCard
  // While loading or after a failed read the columns keep their shape, so the Kanban never collapses or jumps.
  if (!view) return <div className="board-kanban-columns" role="region" aria-label="Kanban columns" aria-busy={!error}>
    {(Object.keys(statusLabels) as Card['status'][]).map((status, index) => <section key={status} className="board-kanban-column is-placeholder"
      data-status={status} aria-label={statusLabels[status]}>
      <h3>{statusLabels[status]} <small className="board-kanban-count-pending" aria-hidden="true" /></h3>
      {index === 0 && error ? <p className="board-kanban-error" role="alert">Couldn’t load cards. {errorMessage(error)}
        <Button size="sm" variant="ghost" onClick={() => void live.retry()}>Retry</Button></p> : null}
    </section>)}
  </div>
  return <div className="board-kanban-columns" role="region" aria-label="Kanban columns">
    {(Object.keys(statusLabels) as Card['status'][]).map((status, index) => <KanbanColumn key={status} view={view}
      status={status} nodes={nodes} activity={byCard} onOpen={setOpenCard} onFailure={reportFailure}
      notice={index === 0 && retries.length ? <p className="board-kanban-error" role="alert">Couldn’t load cards.
        <Button size="sm" variant="ghost" onClick={() => retries.forEach((retry) => retry())}>Retry</Button></p> : null} />)}
    {openCard ? <KanbanCardDialog client={client} boardId={view.board.id} cardId={openCard} nodes={nodes}
      onClose={() => setOpenCard(undefined)}
      {...(editCard ? { onEdit: () => { setOpenCard(undefined); editCard(openCard) } } : {})} /> : null}
  </div>
}

function KanbanColumn({ view, status, nodes, activity, onOpen, onFailure, notice }: {
  view: MemoryBoardView; status: Card['status']; nodes: readonly MemoryNodeOption[]
  activity: ReadonlyMap<string, KanbanCardActivity>; onOpen(cardId: string): void
  onFailure(status: Card['status'], retry?: () => void): void; notice: ReactNode
}) {
  const query = useMemoryCards(client, view, { status }, true)
  const cards = mergedMemoryItems(query.data?.pages)
  const restart = query.restart
  useEffect(() => { onFailure(status, query.isError ? () => void restart() : undefined) }, [query.isError, restart, onFailure, status])
  return <section className="board-kanban-column" data-status={status} aria-label={statusLabels[status]}>
    <h3>{statusLabels[status]} <small>{view.counts[status]}</small></h3>
    {notice}
    {cards.map((card) => {
      const changed = activity.get(card.id)
      return <div key={card.id} className="board-kanban-card" data-card-id={card.id} data-updated={changed ? '' : undefined}>
        <MemoryCard card={card} nodes={nodes} onOpen={() => onOpen(card.id)} />
        {changed ? <p className="board-kanban-updated" role="status">Updated by {changed.agent}</p> : null}
      </div>
    })}
    {query.hasNextPage ? <Button size="sm" variant="ghost" loading={query.isFetchingNextPage} loadingLabel="Loading cards…"
      onClick={() => void query.fetchNextPage()}>Load more {statusLabels[status]}</Button> : null}
  </section>
}

export type KanbanActivityFlowEdge = Edge<{ pulse: EdgePulse }, 'kanbanActivity'>
/** The light from the Agent that changed a card to the Kanban; it exists only while it travels. */
export const KanbanActivityEdge = memo(function KanbanActivityEdge({ source, target, data }: EdgeProps<KanbanActivityFlowEdge>) {
  const curve = useFloatingCurve(source, target, 0)
  if (!curve || !data) return null
  return <g className="board-kanban-flight" aria-hidden="true"><PulseFlight path={curve.path} pulse={data.pulse} /></g>
})

import type { ReactNode } from 'react'
import type { AgentNodeRef } from '@foreman-code/contracts'
import { Button, Dialog } from '../../../shared/ui/nocturne'
import { useMemoryCardDetail, useMemoryHistory } from '../../memory-boards/queries'
import type { MemoryBoardClient, MemoryCardDetail, MemoryChange, MemoryNodeOption } from '../../memory-boards/ports'
import { errorMessage, nodeLabel, statusLabels, visibleTime } from '../../memory-boards/presentation'

/** One Kanban card in its own window: what its Agent is doing or found, and every update, newest first. */
export function KanbanCardDialog({ client, boardId, cardId, nodes, onClose, onEdit }: {
  client: MemoryBoardClient; boardId: string; cardId: string; nodes: readonly MemoryNodeOption[]
  onClose(): void; onEdit?: () => void
}) {
  const detail = useMemoryCardDetail(client, boardId, cardId)
  const card = detail.data?.card
  return <Dialog open onOpenChange={(open) => { if (!open) onClose() }} size="lg" className="kanban-card-dialog"
    title={card?.title ?? 'Card'} closeLabel="Close card"
    description={card ? `${card.assignee ? nodeLabel(card.assignee, nodes) : 'Unassigned'} · Updated ${visibleTime(card.updatedAt)}` : undefined}
    footer={onEdit ? <Button variant="ghost" onClick={onEdit}>Edit in memory board</Button> : undefined}>
    {detail.data ? <CardWindowBody detail={detail.data} client={client} nodes={nodes} />
      : detail.isError ? <p role="alert">Couldn’t load this card. {errorMessage(detail.error)}
        <Button size="sm" variant="ghost" onClick={() => void detail.refetch()}>Retry</Button></p>
      : <p role="status">Loading card…</p>}
  </Dialog>
}

function CardWindowBody({ detail, client, nodes }: { detail: MemoryCardDetail; client: MemoryBoardClient; nodes: readonly MemoryNodeOption[] }) {
  const history = useMemoryHistory(client, detail, true)
  const card = detail.card
  const updates = history.data?.pages.flatMap((page) => page.items) ?? []
  return <div className="kanban-card-window">
    <p className="kanban-card-window-status">
      <span className="memory-status-pill" data-status={card.status}>{statusLabels[card.status]}</span>
      {card.status === 'done' && card.completionKind === 'dropped' ? <span>Dropped</span> : null}
    </p>
    {card.reason ? <p className="kanban-card-window-reason"><strong>{card.status === 'waiting_for_user' ? 'What you need to do' : 'Reason'}:</strong> {card.reason}</p> : null}
    <section aria-label="Latest notes">
      <h3>Latest notes</h3>
      <p className="memory-preserve-lines">{card.body || 'No notes yet.'}</p>
    </section>
    <section aria-label="Updates">
      <h3>Updates</h3>
      {history.isError ? <p role="alert">Couldn’t load updates. <Button size="sm" variant="ghost" onClick={() => void history.restart()}>Retry</Button></p> : null}
      {updates.length ? <ol className="kanban-card-updates">{updates.map((entry) => <Update key={entry.id} entry={entry} nodes={nodes} />)}</ol>
        : history.isError ? null : <p>No updates yet.</p>}
      {history.hasNextPage ? <Button size="sm" variant="ghost" loading={history.isFetchingNextPage} loadingLabel="Loading updates…"
        onClick={() => void history.fetchNextPage()}>Show earlier updates</Button> : null}
    </section>
  </div>
}

function Update({ entry, nodes }: { entry: MemoryChange; nodes: readonly MemoryNodeOption[] }) {
  const when = visibleTime(entry.occurredAt)
  const runId = entry.provenance?.work?.runId ?? entry.provenance?.execution?.runId
  const created = entry.entityRevision === 1
  const lines = created ? [] : Object.entries(entry.changes ?? {}).flatMap(([field, change]) => {
    const line = changeLine(field, change.after, nodes)
    return line ? [<li key={field}>{line}</li>] : []
  })
  const startedIn = entry.changes?.status?.after as keyof typeof statusLabels | undefined
  return <li className="kanban-card-update" aria-label={`${entry.actor.displayName} · ${when}`}>
    <p className="kanban-card-update-head"><strong>{entry.actor.displayName}</strong><small>{when}{runId ? ` · Run ${runId.slice(0, 8)}` : ''}</small></p>
    {created ? <p>Created this card{startedIn && statusLabels[startedIn] ? ` in ${statusLabels[startedIn]}` : ''}</p> : <ul>{lines}</ul>}
  </li>
}

/** A changed field in words; the outcome of a Done card is already said by its move. */
function changeLine(field: string, after: unknown, nodes: readonly MemoryNodeOption[]): ReactNode {
  const text = typeof after === 'string' ? after : ''
  switch (field) {
    case 'status': return `Moved to ${statusLabels[after as keyof typeof statusLabels] ?? text}`
    case 'body': return text ? <span className="memory-preserve-lines">{text}</span> : 'Cleared the notes'
    case 'reason': return text ? `Reason: ${text}` : 'Cleared the reason'
    case 'title': return `Renamed to “${text}”`
    case 'assignee': return after ? `Assigned to ${nodeLabel(after as AgentNodeRef, nodes)}` : 'Unassigned'
    case 'completionKind': return after === 'dropped' ? 'Dropped' : null
    case 'linkedNodes': return 'Changed the linked Agents'
    default: return `Changed ${field}`
  }
}

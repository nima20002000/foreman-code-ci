import { useMemo, useState } from 'react'
import { MemoryBoardWireSchemas, type MemoryBoardScope } from '@foreman-code/contracts'
import { Icon } from '../../../shared/ui/nocturne'
import { createMemoryBoardClient } from '../../memory-boards/client'
import { useMemoryBoard } from '../../memory-boards/queries'
import type { CiServerSummary } from '../inspect/ciServer'
import './boardDock.css'

const client = createMemoryBoardClient(MemoryBoardWireSchemas)

/** Board objects closed by the viewer sit here, top right of the Board, and still show their activity.
 * Clicking one puts the object back where it was. */
export function BoardDock({ ci, kanban }: {
  ci?: { summary: CiServerSummary; restore(): void } | undefined
  kanban?: { workspaceId: string; workflowId: string; restore(): void } | undefined
}) {
  if (!ci && !kanban) return null
  return <div className="board-dock" role="toolbar" aria-label="Closed board objects">
    {ci ? <CiDockItem summary={ci.summary} restore={ci.restore} /> : null}
    {kanban ? <KanbanDockItem {...kanban} /> : null}
  </div>
}

/** Counts each CI change seen while closed: a request arriving, a job starting or finishing. */
function CiDockItem({ summary, restore }: { summary: CiServerSummary; restore(): void }) {
  const signature = summary.state === 'unavailable' ? undefined
    : `${summary.total}:${summary.queued}:${summary.running}:${summary.failed}:${summary.label}`
  const [seen, setSeen] = useState<{ signature?: string | undefined; count: number }>({ signature, count: 0 })
  // The first real read is the starting point, not news.
  if (signature && signature !== seen.signature) setSeen({ signature, count: seen.signature ? seen.count + 1 : 0 })
  return <DockItem icon="server" label="CI" state={summary.state} count={seen.count} restore={restore}
    description={`CI server, ${summary.label}`} />
}

/** Counts card changes (added, moved, edited) while the Kanban is closed. */
function KanbanDockItem({ workspaceId, workflowId, restore }: { workspaceId: string; workflowId: string; restore(): void }) {
  const scope = useMemo<MemoryBoardScope>(() => ({ kind: 'workflow', workspaceId, workflowId }), [workspaceId, workflowId])
  const [count, setCount] = useState(0)
  useMemoryBoard(client, scope, (change) => { if (change.entity === 'card') setCount((value) => value + 1) })
  return <DockItem icon="grid" label="Kanban" count={count} restore={restore} description="Kanban" />
}

function DockItem({ icon, label, state, count, restore, description }: {
  icon: 'server' | 'grid'; label: string; state?: string; count: number; restore(): void; description: string
}) {
  const news = count ? `, ${count} new ${count === 1 ? 'change' : 'changes'}` : ''
  return <button type="button" className="board-dock-item" data-state={state} data-active={count ? '' : undefined}
    aria-label={`Restore ${description}${news}`} title={`${description}${news}. Click to restore.`} onClick={restore}>
    <Icon name={icon} size={13} />
    <span>{label}</span>
    {state ? <i className="board-dock-dot" aria-hidden="true" /> : null}
    {/* Keyed by the count so every new change pulses again. */}
    {count ? <b key={count} className="board-dock-badge">{count > 99 ? '99+' : count}</b> : null}
  </button>
}

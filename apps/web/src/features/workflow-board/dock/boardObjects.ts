import { useMemo, useState } from 'react'
import { create } from 'zustand'
import type { NodeChange } from '@xyflow/react'
import { CI_SERVER_NODE_ID } from '../inspect/ciServer'

type Spot = { x: number; y: number }
/** Where this viewer keeps a Board's CI server and which objects sit minimized in the dock. Per viewer, like a
 * window layout: closing only minimizes, so nothing here ever removes data. */
type BoardObjects = { ci?: Spot; ciClosed?: boolean; kanbanClosed?: boolean }
const STORAGE_KEY = 'foreman.board-objects'

function saved(): Record<string, BoardObjects> {
  try { return JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? '{}') as Record<string, BoardObjects> }
  catch (error) { console.warn('Board object layout could not be read; using defaults.', error); return {} }
}

export const useBoardObjects = create<{ boards: Record<string, BoardObjects>; change(key: string, patch: BoardObjects): void }>((set) => ({
  boards: typeof window === 'undefined' ? {} : saved(),
  change: (key, patch) => set((state) => {
    const boards = { ...state.boards, [key]: { ...state.boards[key], ...patch } }
    try { window.localStorage.setItem(STORAGE_KEY, JSON.stringify(boards)) }
    catch (error) { console.warn('Board object layout was not saved.', error) }
    return { boards }
  }),
}))
export const boardObjectsKey = (workflow: { workspaceId: string; workflowId: string }) => `${workflow.workspaceId}/${workflow.workflowId}`

/** The CI server's place on one Board: dragged anywhere and kept there, or closed into the dock. */
export function useCiPlacement(workflow: { workspaceId: string; workflowId: string }) {
  const key = boardObjectsKey(workflow)
  const objects = useBoardObjects((state) => state.boards[key])
  const change = useBoardObjects((state) => state.change)
  const [dragging, setDragging] = useState<Spot>()
  const actions = useMemo(() => ({
    close: () => change(key, { ciClosed: true }),
    restore: () => change(key, { ciClosed: false }),
    /** Live drag of the server; every other change belongs to the canvas. */
    applyChanges: (changes: readonly NodeChange[]) => {
      for (const item of changes) if (item.type === 'position' && item.id === CI_SERVER_NODE_ID && item.position) setDragging(item.position)
    },
    moved: (position: Spot) => {
      change(key, { ci: { x: Math.round(position.x), y: Math.round(position.y) } })
      setDragging(undefined)
    },
  }), [change, key])
  return { position: dragging ?? objects?.ci, closed: objects?.ciClosed === true, ...actions }
}

/** The Kanban's minimized state on one Board; whether it is on the Board at all is the saved Kanban layout. */
export function useKanbanDocked(workflow: { workspaceId: string; workflowId: string }) {
  const key = boardObjectsKey(workflow)
  const closed = useBoardObjects((state) => state.boards[key]?.kanbanClosed === true)
  const change = useBoardObjects((state) => state.change)
  return { closed, ...useMemo(() => ({ close: () => change(key, { kanbanClosed: true }),
    restore: () => change(key, { kanbanClosed: false }) }), [change, key]) }
}

import { create } from 'zustand'
import type { Viewport } from '@xyflow/react'

/** The pan and zoom last shown on a workflow's Board. The draft canvas and the Run canvas share it, so moving
 * between them (Start, a Run's finish, Back to draft) keeps the person's view. Local interaction state only. */
export const useBoardViewportStore = create<{ views: Record<string, Viewport>; remember(key: string, view: Viewport): void }>(set => ({
  views: {},
  remember: (key, view) => set(state => ({ views: { ...state.views, [key]: { x: view.x, y: view.y, zoom: view.zoom } } })),
}))
export const boardViewportKey = (workspaceId: string, workflowId: string) => JSON.stringify([workspaceId, workflowId])

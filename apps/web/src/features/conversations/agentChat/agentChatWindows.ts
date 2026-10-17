import { createContext, useContext } from 'react'
import { create } from 'zustand'

/** Position and size of a floating Agent chat window, in pixels inside the Board. */
export type ChatWindowFrame = { x: number; y: number; width: number; height: number }
export type ChatWindowBounds = { width: number; height: number }
export type ResizeEdge = 'n' | 's' | 'e' | 'w' | 'ne' | 'nw' | 'se' | 'sw'

export const CHAT_WINDOW_MIN = { width: 300, height: 320 }
const DEFAULT_SIZE = { width: 400, height: 560 }
const TOP_INSET = 72
const CASCADE = 28

const clamp = (value: number, low: number, high: number) => Math.min(Math.max(value, low), Math.max(low, high))

/** Keeps a frame inside the Board. A Board that has not been measured (0x0) clamps nothing. */
export function clampFrame(frame: ChatWindowFrame, bounds: ChatWindowBounds): ChatWindowFrame {
  const width = bounds.width > 0 ? clamp(frame.width, Math.min(CHAT_WINDOW_MIN.width, bounds.width), bounds.width) : frame.width
  const height = bounds.height > 0 ? clamp(frame.height, Math.min(CHAT_WINDOW_MIN.height, bounds.height), bounds.height) : frame.height
  return {
    width, height,
    x: bounds.width > 0 ? clamp(frame.x, 0, bounds.width - width) : Math.max(0, frame.x),
    y: bounds.height > 0 ? clamp(frame.y, 0, bounds.height - height) : Math.max(0, frame.y),
  }
}

/** New windows open on the right, each one cascaded below and left of the previous. */
export function defaultFrame(bounds: ChatWindowBounds, index: number): ChatWindowFrame {
  const step = (index % 6) * CASCADE
  return clampFrame({ ...DEFAULT_SIZE, x: bounds.width - DEFAULT_SIZE.width - 24 - step, y: TOP_INSET + step }, bounds)
}

export function resizeFrame(start: ChatWindowFrame, edge: ResizeEdge, dx: number, dy: number, bounds: ChatWindowBounds): ChatWindowFrame {
  let { x, y, width, height } = start
  if (edge.includes('e')) width = start.width + dx
  if (edge.includes('s')) height = start.height + dy
  if (edge.includes('w')) { width = start.width - dx; x = start.x + dx }
  if (edge.includes('n')) { height = start.height - dy; y = start.y + dy }
  // The opposite edge stays put once the minimum is reached.
  if (width < CHAT_WINDOW_MIN.width) { if (edge.includes('w')) x = start.x + start.width - CHAT_WINDOW_MIN.width; width = CHAT_WINDOW_MIN.width }
  if (height < CHAT_WINDOW_MIN.height) { if (edge.includes('n')) y = start.y + start.height - CHAT_WINDOW_MIN.height; height = CHAT_WINDOW_MIN.height }
  return clampFrame({ x, y, width, height }, bounds)
}

type ChatWindowsState = {
  /** Open Agent node ids per Board view, back to front. */
  open: Record<string, readonly string[]>
  /** Last position and size per Agent node, so a closed or re-selected window comes back where it was. */
  frames: Record<string, ChatWindowFrame>
  /** Bumped whenever a window is opened or re-selected, so it takes focus. */
  focus: Record<string, number>
  openWindow(scope: string, nodeId: string): void
  raise(scope: string, nodeId: string): void
  closeWindow(scope: string, nodeId: string): void
  setFrame(scope: string, nodeId: string, frame: ChatWindowFrame): void
}

export const chatWindowKey = (scope: string, nodeId: string) => `${scope}|${nodeId}`
const toFront = (ids: readonly string[] = [], nodeId: string) => ids.at(-1) === nodeId ? ids : [...ids.filter((id) => id !== nodeId), nodeId]

/** Local interaction state only: not shareable through the URL and not server state. */
export const useChatWindowsStore = create<ChatWindowsState>((set) => ({
  open: {}, frames: {}, focus: {},
  openWindow: (scope, nodeId) => set((state) => ({
    open: { ...state.open, [scope]: toFront(state.open[scope], nodeId) },
    focus: { ...state.focus, [chatWindowKey(scope, nodeId)]: (state.focus[chatWindowKey(scope, nodeId)] ?? 0) + 1 },
  })),
  raise: (scope, nodeId) => set((state) => {
    const ids = toFront(state.open[scope], nodeId)
    return ids === state.open[scope] ? state : { open: { ...state.open, [scope]: ids } }
  }),
  closeWindow: (scope, nodeId) => set((state) => ({ open: { ...state.open, [scope]: (state.open[scope] ?? []).filter((id) => id !== nodeId) } })),
  setFrame: (scope, nodeId, frame) => set((state) => ({ frames: { ...state.frames, [chatWindowKey(scope, nodeId)]: frame } })),
}))

/** Lets the chat inside a window close that window instead of whatever popover state its builder knows. */
export const WindowCloseContext = createContext<(() => void) | undefined>(undefined)
export const useAgentChatWindowClose = () => useContext(WindowCloseContext)

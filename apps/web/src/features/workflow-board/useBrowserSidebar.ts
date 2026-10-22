import { useCallback } from 'react'
import { useLocation, useNavigate } from '@tanstack/react-router'
import { create } from 'zustand'
import { createJSONStorage, persist } from 'zustand/middleware'

/** Local only: which Agent tabs the person opened or closed in this workflow's browser sidebar, kept for this browser
 * tab across reloads. The URL owns whether the sidebar is open and which tab is selected. */
export const useBrowserSidebarTabs = create<{
  opened: Record<string, string[]>
  /** A closed tab stays closed until the person opens that Agent's browser again. */
  closed: Record<string, string[]>
  add(scope: string, nodeId: string): void
  close(scope: string, nodeId: string): void
}>()(persist(set => ({ opened: {}, closed: {},
  add: (scope, nodeId) => set(state => {
    const opened = state.opened[scope] ?? []
    return { opened: { ...state.opened, [scope]: opened.includes(nodeId) ? opened : [...opened, nodeId] },
      closed: { ...state.closed, [scope]: (state.closed[scope] ?? []).filter(item => item !== nodeId) } }
  }),
  close: (scope, nodeId) => set(state => ({
    opened: { ...state.opened, [scope]: (state.opened[scope] ?? []).filter(item => item !== nodeId) },
    closed: { ...state.closed, [scope]: [...new Set([...state.closed[scope] ?? [], nodeId])] },
  })),
}), { name: 'foreman-browser-sidebar-tabs', storage: createJSONStorage(() => sessionStorage),
  partialize: state => ({ opened: state.opened, closed: state.closed }) }))

export const browserSidebarScope = (workspaceId: string, workflowId: string) => JSON.stringify([workspaceId, workflowId])

/** Open, select and close the Board's agent browser sidebar. */
export function useBrowserSidebar(workspaceId: string, workflowId: string) {
  const location = useLocation(), navigate = useNavigate()
  const pathname = location.pathname
  const isOpen = location.search.boardBrowsers === 1
  const selected = location.search.browserTab
  const scope = browserSidebarScope(workspaceId, workflowId)
  const go = useCallback((change: (search: Record<string, unknown>) => void, replace = false) => {
    void navigate({ to: pathname, hash: true, replace, search: previous => {
      if (previous.workflowId && previous.workflowId !== workflowId) return previous
      const next: Record<string, unknown> = { ...previous, workflowId }
      change(next)
      return next as typeof previous
    } })
  }, [navigate, pathname, workflowId])
  /** Opens the sidebar; with an Agent node, adds and selects that Agent's tab. */
  const open = useCallback((nodeId?: string, options: { replace?: boolean; leavePanel?: boolean } = {}) => {
    if (nodeId) useBrowserSidebarTabs.getState().add(scope, nodeId)
    go(search => {
      search.boardBrowsers = 1
      if (nodeId) search.browserTab = nodeId
      // The node's Browser tab used to open in the floating panel; it now opens here instead.
      if (options.leavePanel) { delete search.boardPanel; delete search.browserSessionId; delete search.browserTabId }
    }, options.replace)
  }, [go, scope])
  const select = useCallback((nodeId: string) => go(search => { search.browserTab = nodeId }, true), [go])
  const close = useCallback(() => go(search => { delete search.boardBrowsers; delete search.browserTab }), [go])
  const toggle = useCallback(() => { if (isOpen) close(); else open() }, [isOpen, open, close])
  /** Closes one Agent tab and selects its neighbour. */
  const closeTab = useCallback((nodeId: string, neighbour?: string) => {
    useBrowserSidebarTabs.getState().close(scope, nodeId)
    if (selected === nodeId || !selected) go(search => {
      if (neighbour) search.browserTab = neighbour
      else delete search.browserTab
    }, true)
  }, [go, scope, selected])
  return { isOpen, selected, scope, open, select, close, toggle, closeTab }
}

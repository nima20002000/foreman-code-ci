import { useCallback, useEffect, useRef, type MutableRefObject } from 'react'
import type { RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { useInspectionPresentation } from './inspect/presentation'

/** The Board's location dialog and Activities drawer, and the guard that keeps editor shortcuts off a shown Run. */
export function useBoardDrawers({ workspaceId, workflowId, current, currentRef, detailsScope }: {
  workspaceId: string; workflowId: string; current: boolean; currentRef: MutableRefObject<boolean>
  detailsScope: RepeatGraphScopeV3 | undefined
}) {
  const detailsRef = useRef(detailsScope)
  detailsRef.current = detailsScope
  const locationKey = JSON.stringify(['board-location-dialog', workspaceId, workflowId])
  const locationOpen = useInspectionPresentation((state) => !!state.open[locationKey])
  const setLocationOpen = useCallback((open: boolean) => {
    if (!open || currentRef.current) useInspectionPresentation.getState().setOpen(locationKey, open)
  }, [locationKey])
  const runsKey = JSON.stringify(['board-run-drawer', workspaceId, workflowId])
  const runsOpen = useInspectionPresentation((state) => !!state.open[runsKey])
  const toolbar = useRef<HTMLDivElement>(null)
  const findActivitiesButton = useCallback(() => toolbar.current?.querySelector<HTMLButtonElement>('button[aria-label="Activities"]') ?? null, [])
  const setRunsOpen = useCallback((open: boolean) => {
    if (open && !currentRef.current && !detailsRef.current) return
    useInspectionPresentation.getState().setOpen(runsKey, open)
    if (!open) setTimeout(() => {
      if (!document.activeElement || document.activeElement === document.body) {
        findActivitiesButton()?.focus()
      }
    }, 0)
  }, [runsKey, findActivitiesButton])
  useEffect(() => {
    if (!current && !detailsScope) setRunsOpen(false)
  }, [current, detailsScope, setRunsOpen])
  useEffect(() => () => {
    useInspectionPresentation.getState().setOpen(runsKey, false)
    useInspectionPresentation.getState().setOpen(locationKey, false)
  }, [runsKey, locationKey])
  useEffect(() => {
    // The preserved editor owns a window-level undo/redo listener. inert only
    // blocks its DOM, not that listener. Leave text inputs and dialogs alone.
    const shortcut = (event: KeyboardEvent) => {
      if (currentRef.current || (!event.ctrlKey && !event.metaKey) || event.altKey
        || !['z', 'y', 's'].includes(event.key.toLowerCase())) return
      if (event.target instanceof Element && event.target.closest('input, textarea, select, [contenteditable="true"], [role="dialog"], dialog')) return
      event.preventDefault(); event.stopImmediatePropagation()
    }
    window.addEventListener('keydown', shortcut, true)
    return () => window.removeEventListener('keydown', shortcut, true)
  }, [])
  return { toolbar, locationOpen, setLocationOpen, runsOpen, setRunsOpen, findActivitiesButton }
}

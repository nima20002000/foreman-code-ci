import { useEffect, useId, useLayoutEffect, useRef, type PointerEvent as ReactPointerEvent, type ReactNode, type RefCallback, type RefObject } from 'react'
import { Icon, IconButton } from './nocturne'
import { raiseFloating, useFloatingZ } from './floatingStack'
import { placeBeside } from './floatingWindow'

/** Beside the node that opened it; below the toolbar when a toolbar button opened it, so the toolbar stays usable. */
function placeNear(width: number, height: number, opener: HTMLElement | null) {
  const rect = opener?.getBoundingClientRect()
  const gap = 8
  if (!rect) {
    // Reopened from a link (no opener): top right, but below the Board toolbar so it never covers it.
    // The toolbar may not have rendered yet, so fall back to the views bar plus one toolbar row.
    const bar = [...document.querySelectorAll<HTMLElement>('.unified-workflow-board [role="toolbar"]')]
      .find(element => element.offsetParent !== null)?.getBoundingClientRect()
    const views = document.querySelector('.workflow-collaboration-toolbar')?.getBoundingClientRect()
    const below = bar ? bar.bottom : views ? views.bottom + 56 : undefined
    if (below !== undefined) return { left: Math.max(gap, window.innerWidth - width - 24),
      top: Math.max(gap, Math.min(below + gap, window.innerHeight - height - gap)) }
  }
  if (!rect || !opener?.closest('.board-topbar, [role="toolbar"]')) return placeBeside(width, height, rect)
  return { left: Math.max(gap, Math.min(rect.right - width, window.innerWidth - width - gap)),
    top: Math.max(gap, Math.min(rect.bottom + gap, window.innerHeight - height - gap)) }
}

/** Shared non-modal Board window for Agent chat and browsers. */
export function FloatingWindow({ active = true, modalOpen = false, opener, label, title, closeLabel, onClose, header, hint, footer, bodyRef, className = '', children }: {
  active?: boolean; modalOpen?: boolean; opener: RefObject<HTMLElement | null>; label: string; title: ReactNode
  closeLabel: string; onClose(): void; header?: ReactNode; hint?: ReactNode; footer?: ReactNode
  bodyRef?: RefCallback<HTMLDivElement>; className?: string; children?: ReactNode
}) {
  const panelRef = useRef<HTMLElement>(null)
  const heldFocus = useRef(false)
  const stackId = useId()
  const zIndex = useFloatingZ(stackId, active && !modalOpen)
  // Open next to the node that opened it; keep the user's position while it stays open.
  useLayoutEffect(() => {
    const panel = panelRef.current
    if (!active || modalOpen || !panel) return
    if (!panel.contains(document.activeElement)) panel.focus({ preventScroll: true })
    if (panel.dataset.placed) return
    const { left, top } = placeNear(panel.offsetWidth, panel.offsetHeight, opener.current)
    panel.style.left = `${left}px`
    panel.style.top = `${top}px`
    panel.dataset.placed = 'true'
  }, [active, modalOpen, opener])
  useEffect(() => { if (!active) delete panelRef.current?.dataset.placed }, [active])
  const drag = (event: ReactPointerEvent<HTMLElement>) => {
    const panel = panelRef.current
    if (!panel || event.button !== 0 || (event.target as Element).closest('button')) return
    const startX = event.clientX - panel.offsetLeft, startY = event.clientY - panel.offsetTop
    const move = (e: PointerEvent) => {
      panel.style.left = `${Math.max(0, Math.min(e.clientX - startX, window.innerWidth - 80))}px`
      panel.style.top = `${Math.max(0, Math.min(e.clientY - startY, window.innerHeight - 40))}px`
    }
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    event.preventDefault()
  }
  const resize = (event: ReactPointerEvent<HTMLElement>) => {
    const panel = panelRef.current
    const edge = event.currentTarget.dataset.edge ?? ''
    if (!panel || event.button !== 0) return
    const start = { x: event.clientX, y: event.clientY, left: panel.offsetLeft, top: panel.offsetTop,
      width: panel.offsetWidth, height: panel.offsetHeight }
    const style = getComputedStyle(panel)
    const minW = parseFloat(style.minWidth) || 280, minH = parseFloat(style.minHeight) || 220
    const move = (e: PointerEvent) => {
      const dx = e.clientX - start.x, dy = e.clientY - start.y
      if (edge.includes('e')) panel.style.width = `${Math.max(minW, start.width + dx)}px`
      if (edge.includes('s')) panel.style.height = `${Math.max(minH, start.height + dy)}px`
      if (edge.includes('w')) {
        const width = Math.max(minW, start.width - dx)
        panel.style.width = `${width}px`
        panel.style.left = `${start.left + start.width - width}px`
      }
      if (edge.includes('n')) {
        const height = Math.max(minH, start.height - dy)
        panel.style.height = `${height}px`
        panel.style.top = `${start.top + start.height - height}px`
      }
    }
    const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
    window.addEventListener('pointermove', move)
    window.addEventListener('pointerup', stop)
    event.preventDefault()
    event.stopPropagation()
  }
  useEffect(() => {
    const panel = panelRef.current
    if (!active || modalOpen || !panel) {
      heldFocus.current = false
      return
    }
    if (document.activeElement && document.activeElement !== document.body) {
      heldFocus.current = panel.contains(document.activeElement)
    }
    const close = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const focused = document.activeElement
      const inside = panel.contains(focused)
      const orphaned = heldFocus.current && (!focused || focused === document.body)
      if (!(inside || orphaned) || document.querySelector('dialog[open]')
        || focused?.closest('[role="listbox"], .n-menu')) return
      event.preventDefault()
      event.stopPropagation()
      onClose()
    }
    const rememberFocus = (event: FocusEvent) => {
      heldFocus.current = panel.contains(event.target as Node | null)
    }
    // A removed focused portal control leaves focus on body; other surfaces retain their own Escape.
    document.addEventListener('keydown', close)
    document.addEventListener('focusin', rememberFocus)
    return () => {
      document.removeEventListener('keydown', close)
      document.removeEventListener('focusin', rememberFocus)
    }
  }, [active, modalOpen, onClose])
  useEffect(() => {
    if (!active) return
    const openedFrom = opener.current
    return () => { if (openedFrom?.isConnected) openedFrom.focus() }
  }, [active, opener])
  return <aside ref={panelRef} tabIndex={-1} className={`workflow-floating-panel ${className}`} aria-label={label}
    hidden={!active || modalOpen} inert={!active || modalOpen} style={{ zIndex }}
    onPointerDownCapture={() => raiseFloating(stackId)} onFocusCapture={() => raiseFloating(stackId)}>
    <header onPointerDown={drag}>
      <h2>{title}</h2>
      {header}
      <IconButton label={closeLabel} variant="ghost" onClick={onClose}><Icon name="close" size={16} /></IconButton>
    </header>
    {hint}
    {(['n', 's', 'e', 'w', 'ne', 'nw', 'se', 'sw'] as const).map(edge =>
      <span key={edge} className="workflow-panel-resize" data-edge={edge} aria-hidden="true" onPointerDown={resize} />)}
    <div className="workflow-floating-panel-body" ref={bodyRef}>{children}</div>
    {footer}
  </aside>
}

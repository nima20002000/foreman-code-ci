import type { PointerEvent as ReactPointerEvent } from 'react'
/**
 * Board/workspace button contract: a button (Inbox, Activities, node chat, Browser) opens a small,
 * non-modal floating window beside the button or node that opened it, never on top of the content it relates to.
 * The user can move and resize it. Exception: the Memory board opens as a dialog because its board editor needs the room.
 */
export function placeBeside(width: number, height: number, anchor: DOMRect | undefined) {
  const gap = 12
  const right = anchor ? anchor.right + gap : window.innerWidth - width - 24
  const left = right + width <= window.innerWidth - gap ? right : (anchor?.left ?? 0) - width - gap
  return {
    left: Math.max(gap, Math.min(left, window.innerWidth - width - gap)),
    top: Math.max(gap, Math.min(anchor?.top ?? 80, window.innerHeight - height - gap)),
  }
}

/** Drag a `[data-floating-window]` by its header; clicks on the header's controls still work. */
export function dragByHeader(event: ReactPointerEvent<HTMLElement>) {
  const panel = event.currentTarget.closest<HTMLElement>('[data-floating-window]')
  if (!panel || event.button !== 0 || (event.target as HTMLElement).closest('button, input, select, textarea, a')) return
  const rect = panel.getBoundingClientRect()
  const parent = (panel.offsetParent ?? document.body).getBoundingClientRect()
  const dx = event.clientX - rect.left, dy = event.clientY - rect.top
  const move = (next: PointerEvent) => {
    panel.style.left = `${next.clientX - dx - parent.left}px`
    panel.style.top = `${Math.max(0, next.clientY - dy - parent.top)}px`
    panel.style.right = 'auto'
  }
  const stop = () => { window.removeEventListener('pointermove', move); window.removeEventListener('pointerup', stop) }
  window.addEventListener('pointermove', move)
  window.addEventListener('pointerup', stop)
  event.preventDefault()
}

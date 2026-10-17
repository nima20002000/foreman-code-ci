import { useEffect, useLayoutEffect, useRef, type ReactNode } from 'react'
import { IconButton, Icon } from '../../shared/ui/nocturne'
import { useFloatingSurface } from '../../shared/ui/nocturne/useFloatingSurface'
import './activitiesPopover.css'

/** A small non-modal popover anchored to the toolbar's Activities button. Outside click, Escape or a second press on the button close it. */
export function ActivitiesPopover({ open, onClose, findAnchor, children }: {
  open: boolean; onClose(): void; findAnchor(): HTMLElement | null; children: ReactNode
}) {
  return open ? <PopoverSurface onClose={onClose} findAnchor={findAnchor}>{children}</PopoverSurface> : null
}

function PopoverSurface({ onClose, findAnchor, children }: { onClose(): void; findAnchor(): HTMLElement | null; children: ReactNode }) {
  const surface = useRef<HTMLElement>(null)
  const anchor = useRef<HTMLElement | null>(null)
  const close = useRef(onClose)
  close.current = onClose
  useLayoutEffect(() => { anchor.current = findAnchor() }, [findAnchor])
  useFloatingSurface(true, anchor, surface, 420, 'end')
  useEffect(() => {
    const trigger = anchor.current
    const outside = (event: PointerEvent) => {
      const target = event.target
      if (target instanceof Node && !surface.current?.contains(target) && !trigger?.contains(target)) close.current()
    }
    const escape = (event: KeyboardEvent) => {
      if (event.key !== 'Escape' || event.defaultPrevented) return
      const target = event.target
      if (target instanceof Element && !surface.current?.contains(target) && target !== document.body && target !== trigger) return
      event.preventDefault()
      close.current()
      trigger?.focus()
    }
    // A second press on the button closes the popover instead of reopening it.
    const toggle = (event: Event) => { event.stopPropagation(); close.current() }
    document.addEventListener('pointerdown', outside, true)
    document.addEventListener('keydown', escape)
    trigger?.addEventListener('click', toggle)
    surface.current?.focus()
    return () => {
      document.removeEventListener('pointerdown', outside, true)
      document.removeEventListener('keydown', escape)
      trigger?.removeEventListener('click', toggle)
    }
  }, [])
  return <section ref={surface} popover="manual" tabIndex={-1} aria-label="Activities popover" className="n-theme board-activities-popover">
    <header className="board-activities-popover-header">
      <h2>Activities</h2>
      <IconButton label="Close Activities" onClick={() => { close.current(); anchor.current?.focus() }}><Icon name="close" size={14} /></IconButton>
    </header>
    <div className="board-activities-popover-body">{children}</div>
  </section>
}

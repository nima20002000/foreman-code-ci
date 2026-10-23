import { useEffect, useRef } from 'react'

export interface OutsidePressOptions {
  /** The press event that dismisses. React Flow canvases stop bubbling, so most surfaces listen in the capture phase. */
  event?: 'pointerdown' | 'mousedown'
  capture?: boolean
  /**
   * Dismiss on the click that ends a press, and only when both the press and the click were outside. A drag that
   * starts inside the surface (selecting text, resizing) never dismisses it.
   */
  requireOutsideRelease?: boolean
}

/**
 * The one outside-press listener for floating surfaces, menus and popovers. `isInside` decides what counts as the
 * surface (its element, its trigger, nested menus); `onOutside` runs for every other press while `enabled`.
 */
export function useOutsidePress(enabled: boolean, isInside: (target: Node) => boolean, onOutside: (event: Event) => void,
  { event = 'pointerdown', capture = true, requireOutsideRelease = false }: OutsidePressOptions = {}): void {
  const latest = useRef({ isInside, onOutside })
  useEffect(() => { latest.current = { isInside, onOutside } })
  useEffect(() => {
    if (!enabled) return
    const outside = (target: EventTarget | null) => target instanceof Node && !latest.current.isInside(target)
    if (!requireOutsideRelease) {
      const press = (pressEvent: Event) => { if (outside(pressEvent.target)) latest.current.onOutside(pressEvent) }
      document.addEventListener(event, press, capture)
      return () => document.removeEventListener(event, press, capture)
    }
    let startedOutside = false
    const press = (pressEvent: Event) => { startedOutside = outside(pressEvent.target) }
    const click = (clickEvent: MouseEvent) => {
      if (startedOutside && outside(clickEvent.target)) latest.current.onOutside(clickEvent)
      startedOutside = false
    }
    document.addEventListener(event, press, capture)
    document.addEventListener('click', click, capture)
    return () => {
      document.removeEventListener(event, press, capture)
      document.removeEventListener('click', click, capture)
    }
  }, [enabled, event, capture, requireOutsideRelease])
}

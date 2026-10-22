import { useRef, type PointerEvent } from 'react'
import './agentProximity.css'

/** How far around an Agent circle its options appear, in circle radii; the option buttons sit inside this ring. */
const RING = 1.6

function mark(root: HTMLElement, point?: { x: number; y: number }) {
  for (const agent of root.querySelectorAll<HTMLElement>('.n-agent')) {
    const box = agent.getBoundingClientRect(), radius = box.width / 2
    const near = !!point && radius > 0
      && Math.hypot(point.x - box.left - radius, point.y - box.top - box.height / 2) <= radius * RING
    if (near) agent.setAttribute('data-near', '')
    else agent.removeAttribute('data-near')
  }
}

/** An Agent's option buttons (chat, settings, info, connector) appear while the pointer is near its circle, not
 * only over it, so moving toward an option never hides it. Spread the handlers on the canvas container. */
export function useAgentProximity() {
  const frame = useRef(0)
  return {
    onPointerMove: (event: PointerEvent<HTMLElement>) => {
      const root = event.currentTarget, point = { x: event.clientX, y: event.clientY }
      cancelAnimationFrame(frame.current)
      frame.current = requestAnimationFrame(() => mark(root, point))
    },
    onPointerLeave: (event: PointerEvent<HTMLElement>) => {
      cancelAnimationFrame(frame.current)
      mark(event.currentTarget)
    },
  }
}

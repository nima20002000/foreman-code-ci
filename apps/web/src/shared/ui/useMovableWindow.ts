import { useEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent } from 'react'

/** Grip edges of a movable, resizable non-modal window (Operator chat, approval inbox). */
export const windowResizeEdges = ['n', 'ne', 'e', 'se', 's', 'sw', 'w', 'nw'] as const
type Edge = typeof windowResizeEdges[number]
type Box = { left: number; top: number; width: number; height: number }
const edgeNames: Record<Edge, string> = { n: 'top', ne: 'top right', e: 'right', se: 'bottom right', s: 'bottom', sw: 'bottom left', w: 'left', nw: 'top left' }
const arrows = ['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown']
const step = (key: string) => ({ dx: key === 'ArrowLeft' ? -32 : key === 'ArrowRight' ? 32 : 0, dy: key === 'ArrowUp' ? -32 : key === 'ArrowDown' ? 32 : 0 })

/**
 * Position and size of a floating window, moved by its header grip and resized from any edge, by pointer or arrow keys.
 * The window stays inside the viewport. On a narrow screen it fills the screen and cannot be moved.
 */
export function useMovableWindow({ name, minWidth, minHeight, narrow }: {
  /** Lower-case name used in grip labels, such as "Operator chat". */
  name: string
  minWidth: number
  minHeight: number
  narrow: () => boolean
}) {
  const panelRef = useRef<HTMLElement>(null)
  const [box, setBox] = useState<Box>()
  const resizing = useRef<{ edge: Edge; x: number; y: number; box: Box } | undefined>(undefined)
  const moving = useRef<{ x: number; y: number; box: Box } | undefined>(undefined)
  const readBox = (): Box | undefined => {
    const rect = panelRef.current?.getBoundingClientRect()
    return rect ? { left: rect.left, top: rect.top, width: rect.width, height: rect.height } : undefined
  }
  const moveTo = (start: Box, dx: number, dy: number) => setBox({ ...start,
    left: Math.max(8, Math.min(start.left + dx, window.innerWidth - start.width - 8)),
    top: Math.max(8, Math.min(start.top + dy, window.innerHeight - start.height - 8)),
  })
  const resize = (start: Box, edge: Edge, dx: number, dy: number) => {
    const minimumWidth = Math.min(minWidth, window.innerWidth - 16)
    const minimumHeight = Math.min(minHeight, window.innerHeight - 16)
    let left = start.left, top = start.top, right = left + start.width, bottom = top + start.height
    if (edge.includes('w')) left = Math.max(8, Math.min(left + dx, right - minimumWidth))
    if (edge.includes('e')) right = Math.min(window.innerWidth - 8, Math.max(right + dx, left + minimumWidth))
    if (edge.includes('n')) top = Math.max(8, Math.min(top + dy, bottom - minimumHeight))
    if (edge.includes('s')) bottom = Math.min(window.innerHeight - 8, Math.max(bottom + dy, top + minimumHeight))
    setBox({ left, top, width: right - left, height: bottom - top })
  }
  useEffect(() => {
    const clamp = () => setBox((current) => {
      if (!current) return current
      const width = Math.min(current.width, window.innerWidth - 16), height = Math.min(current.height, window.innerHeight - 16)
      return { width, height, left: Math.max(8, Math.min(current.left, window.innerWidth - width - 8)), top: Math.max(8, Math.min(current.top, window.innerHeight - height - 8)) }
    })
    window.addEventListener('resize', clamp)
    return () => window.removeEventListener('resize', clamp)
  }, [])
  return {
    panelRef,
    style: box ? { position: 'fixed', ...box } as CSSProperties : undefined,
    /** Opens the window under a toolbar button, right edges aligned, so it never covers the toolbar. */
    placeBelow(anchor: DOMRect) {
      const start = readBox()
      if (!start || narrow()) return
      setBox({ ...start,
        left: Math.max(8, Math.min(anchor.right - start.width, window.innerWidth - start.width - 8)),
        top: Math.max(8, Math.min(anchor.bottom + 8, window.innerHeight - start.height - 8)) })
    },
    moveGrip: {
      'aria-label': `Move ${name}`,
      'aria-description': `Drag or use arrow keys to move the ${name}.`,
      onPointerDown(event: PointerEvent<HTMLElement>) {
        if (narrow() || event.button !== 0) return
        const start = readBox()
        if (!start) return
        event.preventDefault()
        moving.current = { x: event.clientX, y: event.clientY, box: start }
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const start = moving.current
        if (start) moveTo(start.box, event.clientX - start.x, event.clientY - start.y)
      },
      onPointerUp() { moving.current = undefined },
      onPointerCancel() { moving.current = undefined },
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (narrow() || !arrows.includes(event.key)) return
        event.preventDefault()
        const start = readBox()
        const { dx, dy } = step(event.key)
        if (start) moveTo(start, dx, dy)
      },
    },
    grip: (edge: Edge) => ({
      'aria-label': edge === 'nw' ? `Resize ${name}` : `Resize ${name} from ${edgeNames[edge]}`,
      onPointerDown(event: PointerEvent<HTMLElement>) {
        const start = readBox()
        if (!start || event.button !== 0) return
        event.preventDefault()
        resizing.current = { edge, x: event.clientX, y: event.clientY, box: start }
        event.currentTarget.setPointerCapture(event.pointerId)
      },
      onPointerMove(event: PointerEvent<HTMLElement>) {
        const start = resizing.current
        if (start) resize(start.box, start.edge, event.clientX - start.x, event.clientY - start.y)
      },
      onPointerUp() { resizing.current = undefined },
      onPointerCancel() { resizing.current = undefined },
      onKeyDown(event: KeyboardEvent<HTMLElement>) {
        if (!arrows.includes(event.key)) return
        event.preventDefault()
        const start = readBox()
        const { dx, dy } = step(event.key)
        if (start) resize(start, edge, dx, dy)
      },
    }),
  }
}

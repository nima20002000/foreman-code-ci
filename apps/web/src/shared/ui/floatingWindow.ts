/**
 * Board/workspace button contract: a button (Inbox, Group chat, Activities, node chat, Browser) opens a small,
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

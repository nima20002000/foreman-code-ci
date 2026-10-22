/** True while any dialog is open on the page. Board keyboard shortcuts (Undo, Delete, Copy, Paste) stay off then.
 * Closed dialogs stay mounted, so only an open `<dialog>` or a shown modal element counts. */
export function modalOpen(): boolean {
  if (typeof document === 'undefined') return false
  return [...document.querySelectorAll<HTMLElement>('dialog[open], [aria-modal="true"]')].some(element =>
    element instanceof HTMLDialogElement ? element.open : element.getClientRects().length > 0)
}

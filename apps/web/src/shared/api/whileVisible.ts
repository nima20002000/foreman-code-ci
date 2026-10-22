/**
 * Keeps a stream subscription open only while its tab is visible. Browsers allow six HTTP/1.1 connections per host;
 * background tabs that each hold event streams use them all, and a newly opened tab then hangs waiting for a connection.
 * Subscriptions reopen (and resync from their snapshot) when the tab becomes visible again.
 */
export function whileVisible(subscribe: () => () => void): () => void {
  if (typeof document === 'undefined') return subscribe()
  let stop: (() => void) | undefined = document.hidden ? undefined : subscribe()
  const onVisibility = () => {
    if (document.hidden) { stop?.(); stop = undefined }
    else stop ??= subscribe()
  }
  document.addEventListener('visibilitychange', onVisibility)
  return () => { document.removeEventListener('visibilitychange', onVisibility); stop?.(); stop = undefined }
}

import type { z } from 'zod'
import { eventStreamsAvailable, openEventStreamScope, type EventStreamConnection } from '../../shared/api/eventStream'
import type { MemoryChange, MemoryStreamListeners } from './ports'
import { whileVisible } from '../../shared/api/whileVisible'

/** One visible owner, no hidden polling. `ready` permits a bounded snapshot
 * after registration, or an honest offline/reconnecting fallback. */
function subscribeMemoryBoardNow(boardId: string, schema: z.ZodType<MemoryChange>, listeners: MemoryStreamListeners): () => void {
  const opened = openEventStreamScope()
  if (!opened) return () => undefined
  const scope = opened
  const valid = scope.valid
  let source: EventStreamConnection | undefined, timer: ReturnType<typeof setTimeout> | undefined
  let failures = 0
  const offline = () => typeof navigator !== 'undefined' && !navigator.onLine
  const disconnect = () => { source?.close(); source = undefined; clearTimeout(timer); timer = undefined }
  const reconnect = () => {
    if (!valid()) return
    disconnect()
    listeners.connection(offline() ? 'offline' : 'reconnecting')
    // A failed stream cannot make API-owned memory unavailable. Read a bounded
    // snapshot with the reconnecting label; the next open reconciles again.
    listeners.ready()
    if (!offline()) timer = setTimeout(connect, Math.min(30_000, 500 * 2 ** Math.min(failures++, 6)))
  }
  function connect() {
    if (!valid()) return
    if (offline()) { listeners.connection('offline'); listeners.ready(); return }
    if (!eventStreamsAvailable()) {
      listeners.connection('unavailable'); listeners.ready(); return
    }
    listeners.connection(failures ? 'reconnecting' : 'connecting')
    const receive = (wire: Event) => {
      try {
        const change = schema.parse(JSON.parse((wire as MessageEvent<string>).data))
        if (change.boardId !== boardId) { listeners.reset(); return }
        listeners.change(change)
      } catch { listeners.reset() }
    }
    source = scope.connect(`/api/memory-boards/${encodeURIComponent(boardId)}/events`, {
      open: () => {
        failures = 0
        listeners.ready()
        listeners.connection('connected')
      },
      change: receive,
      message: receive,
      reset: () => listeners.reset(),
      error: reconnect,
    })
  }
  const onOffline = () => { if (valid()) { disconnect(); listeners.connection('offline'); listeners.ready() } }
  const onOnline = () => { if (valid()) { disconnect(); connect() } }
  window.addEventListener('offline', onOffline); window.addEventListener('online', onOnline)
  scope.onClose(() => {
    disconnect()
    window.removeEventListener('offline', onOffline); window.removeEventListener('online', onOnline)
  })
  connect()
  return scope.close
}

export const subscribeMemoryBoard: typeof subscribeMemoryBoardNow = (...args) => whileVisible(() => subscribeMemoryBoardNow(...args))

import { assertSession, sessionGeneration, sessionIsSwitching, sessionSignal } from './sessionBoundary'

/** One open same-origin EventSource inside a stream scope. */
export interface EventStreamConnection {
  readonly source: EventSource
  /** False once this connection or its scope closed: a replaced connection's late events are ignored. */
  readonly active: boolean
  close(): void
}

/**
 * The shared server-sent-event boundary. A scope belongs to the document session that opened it: it closes when
 * that session changes, its own signals abort or the subscriber closes it, and only then. Handlers of its
 * connections run only while the scope is valid and the connection active.
 */
export interface EventStreamScope {
  /** False once closed, aborted or the session changed; a stale scope closes itself. */
  valid(): boolean
  connect(url: string, handlers: Record<string, (event: Event) => void>): EventStreamConnection
  /** Run when the scope closes, once. */
  onClose(cleanup: () => void): void
  close(): void
}

export const eventStreamsAvailable = () => typeof EventSource !== 'undefined'

/** Undefined while the session is switching: no new stream may start for an app instance that is leaving. */
export function openEventStreamScope(...signals: AbortSignal[]): EventStreamScope | undefined {
  if (sessionIsSwitching()) return undefined
  const generation = sessionGeneration()
  const all = [...signals, sessionSignal()]
  const cleanups: (() => void)[] = []
  const connections = new Set<{ close(): void }>()
  let closed = false
  const close = () => {
    if (closed) return
    closed = true
    for (const signal of all) signal.removeEventListener('abort', close)
    for (const connection of [...connections]) connection.close()
    for (const cleanup of cleanups.splice(0)) cleanup()
  }
  const valid = () => {
    if (closed) return false
    try { assertSession(generation) } catch { close(); return false /* ignore: a session change closes this scope */ }
    if (all.some((signal) => signal.aborted)) { close(); return false }
    return true
  }
  const connect = (url: string, handlers: Record<string, (event: Event) => void>): EventStreamConnection => {
    const source = new EventSource(url)
    let active = true
    const bound = Object.entries(handlers).map(([type, handler]) => {
      const listener = (event: Event) => { if (active && valid()) handler(event) }
      source.addEventListener(type, listener)
      return [type, listener] as const
    })
    const connection = {
      source,
      get active() { return active && !closed },
      close() {
        if (!active) return
        active = false
        connections.delete(connection)
        for (const [type, listener] of bound) source.removeEventListener(type, listener)
        source.close()
      },
    }
    connections.add(connection)
    if (closed) connection.close()
    return connection
  }
  for (const signal of all) signal.addEventListener('abort', close, { once: true })
  if (all.some((signal) => signal.aborted)) close()
  return { valid, connect, close, onClose: (cleanup) => { if (closed) cleanup(); else cleanups.push(cleanup) } }
}

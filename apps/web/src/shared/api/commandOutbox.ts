import { useEffect, useRef } from 'react'
import { create } from 'zustand'
import { assertSession, sessionGeneration, sessionIsSwitching, SessionChangedError } from './sessionBoundary'

/**
 * Shared pieces of the durable command outboxes. A command is written, and read back, before its request is sent,
 * so a lost response or a reload retries the same command identity instead of creating another. Each outbox keeps
 * its own storage key, stored format, and recovery rules; these helpers only own storage access, verification,
 * cross-tab exclusion and the local Zustand view.
 */

/** The raw stored command, or undefined when none is retained. A storage failure throws `unavailable`. */
export function readStoredCommand(key: string, unavailable: string, storage: Storage = window.localStorage): string | undefined {
  let raw: string | null
  try { raw = storage.getItem(key) } catch { throw new Error(unavailable) }
  return raw ?? undefined
}

/** Write (or with `undefined`, remove) a command and read it back; any mismatch or storage failure throws `unavailable`. */
export function writeStoredCommand(key: string, raw: string | undefined, unavailable: string,
  storage: Storage = window.localStorage): void {
  try {
    if (raw === undefined) storage.removeItem(key)
    else storage.setItem(key, raw)
    if (storage.getItem(key) !== (raw ?? null)) throw new Error(unavailable)
  } catch { throw new Error(unavailable) }
}

/** Cross-tab exclusion for one outbox, fenced to the document session that asked for it. */
export async function withCommandLock<T>(name: string, work: () => T,
  options: { unavailable: string; signal?: AbortSignal }): Promise<T> {
  const generation = sessionGeneration()
  if (sessionIsSwitching()) throw new SessionChangedError()
  const locks = typeof navigator === 'undefined' ? undefined : navigator.locks
  if (!locks) throw new Error(options.unavailable)
  const run = () => { assertSession(generation); return work() }
  return options.signal ? locks.request(name, { mode: 'exclusive', signal: options.signal }, run) : locks.request(name, run)
}

/**
 * Zustand holds each outbox's local view of its retained command, per document session. Storage stays the source
 * of truth: the view re-reads on mount and when another tab changes the key.
 */
export function createOutboxView<Record>() {
  const store = create<{ records: { [id: string]: Record } }>(() => ({ records: {} }))
  const id = (key: string) => JSON.stringify([sessionGeneration(), key])
  const publish = (key: string, value: Record) => {
    const identity = id(key)
    store.setState((state) => ({ records: { ...state.records, [identity]: value } }))
  }
  function useRecord(key: string, read: () => Record, failed: (error: unknown) => Record): Record | undefined {
    const identity = id(key)
    const value = store((state) => state.records[identity])
    const latest = useRef({ read, failed })
    useEffect(() => { latest.current = { read, failed } })
    useEffect(() => {
      const update = () => {
        let next: Record
        try { next = latest.current.read() } catch (error) { next = latest.current.failed(error) }
        store.setState((state) => ({ records: { ...state.records, [identity]: next } }))
      }
      const changed = (event: StorageEvent) => { if (event.key === null || event.key === key) update() }
      update()
      window.addEventListener('storage', changed)
      return () => window.removeEventListener('storage', changed)
    }, [identity, key])
    return value
  }
  return { publish, useRecord, clear: () => store.setState({ records: {} }) }
}

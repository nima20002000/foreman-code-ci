import type { EventStreamScope } from './eventStream'

/** Decode with the shared contract; callers retain their transport-error and recovery policies. */
export function parseChatStreamEvent<T>(schema: { parse(value: unknown): T }, wire: Event): T {
  return schema.parse(JSON.parse((wire as MessageEvent<string>).data))
}

/** Bind contract events through the session-owned transport with one invalid-event path. */
export function connectChatStream<T>(scope: EventStreamScope, url: string, {
  schema, events, receive, invalid, handlers,
}: {
  schema: { parse(value: unknown): T }
  events: readonly string[]
  receive(event: T): void
  invalid(error: unknown): void
  handlers: Record<string, (event: Event) => void>
}) {
  const read = (wire: Event) => {
    try { receive(parseChatStreamEvent(schema, wire)) } catch (error) { invalid(error) }
  }
  return scope.connect(url, { ...handlers, ...Object.fromEntries(events.map(name => [name, read])) })
}

/** Connection-local event IDs are separate from conversation revisions and native turn IDs. */
export function createChatStreamSequence() {
  let highWater = -1
  const seen = new Set<number>()
  return {
    reset() { highWater = -1; seen.clear() },
    remember(id: number): 'duplicate' | 'stale' | 'gap' | 'next' {
      if (seen.has(id)) return 'duplicate'
      seen.add(id)
      if (seen.size > 256) seen.delete(seen.values().next().value!)
      if (id <= highWater) return 'stale'
      return highWater >= 0 && id > highWater + 1 ? 'gap' : 'next'
    },
    advance(id: number) { highWater = id },
  }
}

import { AgentChatStateSchema, AgentChatStreamEventSchema, type AgentChatState, type AgentChatStreamEvent } from '@foreman-code/contracts/agent-chat'
import { agentChatConversationPath } from './agentChat'
import { eventStreamsAvailable, openEventStreamScope, type EventStreamConnection } from './eventStream'
import { whileVisible } from './whileVisible'

export type AgentChatConnection = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'unavailable'

/** Connection-owned event ids are NOT conversation revisions or native turn ids. */
function subscribeAgentChatNow(workspaceId: string, conversationId: string, listeners: {
  snapshot(state: AgentChatState): void
  event(event: AgentChatStreamEvent): void
  refetch(): void
  connection(state: AgentChatConnection): void
}): () => void {
  const opened = openEventStreamScope()
  if (!opened) return () => {}
  const scope = opened
  if (!eventStreamsAvailable()) { scope.close(); listeners.connection('unavailable'); return () => {} }
  const valid = scope.valid
  let source: EventStreamConnection | undefined, timer: ReturnType<typeof setTimeout> | undefined, failures = 0
  const offline = () => typeof navigator !== 'undefined' && !navigator.onLine
  const disconnect = () => { source?.close(); source = undefined; clearTimeout(timer); timer = undefined }
  const retry = () => {
    if (!valid()) return
    disconnect()
    listeners.connection(offline() ? 'offline' : 'reconnecting')
    if (!valid()) return
    listeners.refetch()
    if (!valid()) return
    if (!offline()) timer = setTimeout(connect, Math.min(30_000, 500 * 2 ** Math.min(failures++, 6)))
  }
  function connect() {
    if (!valid()) return
    if (offline()) { listeners.connection('offline'); return }
    listeners.connection(failures ? 'reconnecting' : 'connecting')
    if (!valid()) return
    // The frozen seam doesn't promise resumable SSE cursors. Every connection must start with
    // a full snapshot. Dedup is local to that connection; GET/snapshot revisions fence refreshes.
    let ready = false, highWater = -1
    const seen = new Set<number>()
    const receive = (wire: Event) => {
      if (!('data' in wire) || typeof wire.data !== 'string') { retry(); return }
      let event: AgentChatStreamEvent
      try { event = AgentChatStreamEventSchema.parse(JSON.parse(wire.data)) } catch { retry(); return }
      if (event.conversationId !== conversationId) { retry(); return }
      if (event.type === 'snapshot') {
        const parsed = AgentChatStateSchema.safeParse(event.data.state ?? event.data)
        if (!parsed.success || parsed.data.conversation?.id !== conversationId) { retry(); return }
        ready = true; failures = 0; highWater = -1; seen.clear()
        listeners.snapshot(parsed.data)
        if (valid() && current.active) listeners.connection('connected')
        return
      }
      if (seen.has(event.id)) return
      seen.add(event.id)
      if (seen.size > 256) seen.delete(seen.values().next().value!)
      if (event.id <= highWater) { listeners.refetch(); return }
      if (ready && highWater >= 0 && event.id > highWater + 1) { listeners.refetch(); if (!valid() || !current.active) return }
      highWater = event.id
      if (!ready && event.type === 'state' && event.data.snapshotRequired === true) {
        // The server's snapshot exceeded its byte budget: the stream is live, read state over HTTP.
        ready = true; failures = 0; highWater = -1; seen.clear()
        listeners.refetch()
        if (valid() && current.active) listeners.connection('connected')
      } else {
        if (!ready) { retry(); return }
        // data is deliberately opaque in the frozen contract. The consumer reads a full,
        // revisioned state instead of guessing text offsets or concatenating replayed deltas.
        listeners.event(event)
      }
    }
    const types = ['snapshot', 'delta', 'message', 'activity', 'turn', 'state', 'error']
    const current: EventStreamConnection = scope.connect(`${agentChatConversationPath(workspaceId, conversationId)}/events`, {
      open: () => listeners.refetch(),
      ...Object.fromEntries(types.map((type) => [type, receive])),
    })
    source = current
  }
  const onOffline = () => { if (valid()) { disconnect(); listeners.connection('offline') } }
  const onOnline = () => { if (valid()) { disconnect(); listeners.refetch(); connect() } }
  window.addEventListener('offline', onOffline); window.addEventListener('online', onOnline)
  scope.onClose(() => {
    disconnect()
    window.removeEventListener('offline', onOffline); window.removeEventListener('online', onOnline)
  })
  connect()
  return scope.close
}

export const subscribeAgentChat: typeof subscribeAgentChatNow = (...args) => whileVisible(() => subscribeAgentChatNow(...args))

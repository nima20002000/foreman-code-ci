import { eventStreamsAvailable, openEventStreamScope } from '../../shared/api/eventStream'
import { WorkflowChatEventSchema, type WorkflowChatEvent } from '@foreman-code/contracts'
import { workflowChatRoot, type WorkflowChatScope } from './client'
import { whileVisible } from '../../shared/api/whileVisible'

function subscribeWorkflowChatNow(scope: WorkflowChatScope, listeners: {
  event(event: WorkflowChatEvent): void
  reconnect(): void
  connection(state: 'connected' | 'reconnecting' | 'unavailable'): void
}): () => void {
  if (!eventStreamsAvailable()) { listeners.connection('unavailable'); return () => {} }
  const stream = openEventStreamScope()
  if (!stream) return () => {}
  const receive = (event: Event) => {
    try {
      if (!('data' in event) || typeof event.data !== 'string') throw new Error('Missing event data')
      listeners.event(WorkflowChatEventSchema.parse(JSON.parse(event.data)))
    } catch { listeners.reconnect() }
  }
  stream.connect(`${workflowChatRoot(scope)}/events`, {
    open: () => { listeners.connection('connected'); listeners.reconnect() },
    error: () => { listeners.connection('reconnecting'); listeners.reconnect() },
    ...Object.fromEntries(['message', 'post', 'receipt', 'change'].map((name) => [name, receive])),
  })
  return stream.close
}

export const subscribeWorkflowChat: typeof subscribeWorkflowChatNow = (...args) => whileVisible(() => subscribeWorkflowChatNow(...args))

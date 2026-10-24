import { connectChatStream } from '../../shared/api/chatStreamEvents'
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
  connectChatStream(stream, `${workflowChatRoot(scope)}/events`, {
    schema: WorkflowChatEventSchema, events: ['message', 'post', 'receipt', 'change'],
    receive: event => listeners.event(event), invalid: () => listeners.reconnect(),
    handlers: {
      open: () => { listeners.connection('connected'); listeners.reconnect() },
      error: () => { listeners.connection('reconnecting'); listeners.reconnect() },
    },
  })
  return stream.close
}

export const subscribeWorkflowChat: typeof subscribeWorkflowChatNow = (...args) => whileVisible(() => subscribeWorkflowChatNow(...args))

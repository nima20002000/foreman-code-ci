import { connectChatStream } from '../../shared/api/chatStreamEvents'
import { WorkflowHierarchyChangeSchema } from '@foreman-code/contracts'
import { eventStreamsAvailable, openEventStreamScope } from '../../shared/api/eventStream'
import { hierarchyPath } from './client'
import { whileVisible } from '../../shared/api/whileVisible'

function subscribeHierarchyNow(scope: { workspaceId: string; workflowId: string; runId: string },
  listeners: { changed(): void; unavailable(): void; connection(connected: boolean): void }): () => void {
  if (!eventStreamsAvailable()) return () => {}
  const stream = openEventStreamScope()
  if (!stream) return () => {}
  let cursor: string | undefined
  connectChatStream(stream, `${hierarchyPath(scope)}/events?${new URLSearchParams({ runId: scope.runId })}`, {
    schema: WorkflowHierarchyChangeSchema, events: ['changed'],
    receive: event => {
      if (event.runId !== scope.runId) throw new Error('Report scope changed')
      if (event.cursor !== cursor) { cursor = event.cursor; listeners.changed() }
      listeners.connection(true)
    },
    invalid: () => { listeners.connection(false); listeners.changed() },
    handlers: {
      open: () => { listeners.connection(true); listeners.changed() },
      error: () => listeners.connection(false),
      unavailable: () => {
        stream.close()
        listeners.connection(false)
        listeners.unavailable()
      },
    },
  })
  return stream.close
}

export const subscribeHierarchy: typeof subscribeHierarchyNow = (...args) => whileVisible(() => subscribeHierarchyNow(...args))

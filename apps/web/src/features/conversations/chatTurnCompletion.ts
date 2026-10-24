import { useQueryClient, type QueryClient } from '@tanstack/react-query'
import { createClientScopedStore } from '../../shared/api/clientScopedStore'
import { sessionGeneration } from '../../shared/api/sessionBoundary'

const COMPLETION_LIMIT = 200
const completions = createClientScopedStore<{ completed: readonly string[] }>(() => ({ completed: [] }))
const completionId = (conversationId: string, requestId: string, generation: number) =>
  JSON.stringify([generation, conversationId, requestId])

/** Terminal notifications hide responding dots while the full snapshot is still being read.
 * Keep them locally across reconnects and stale reads; they do not change command availability. */
export function markChatTurnCompleted(client: QueryClient, conversationId: string, requestId: string): void {
  const id = completionId(conversationId, requestId, sessionGeneration())
  completions.write(client, (state) => state.completed.includes(id) ? state
    : { completed: [...state.completed, id].slice(-COMPLETION_LIMIT) })
}

export function useChatTurnCompleted(conversationId: string | undefined, requestId: string | null | undefined): boolean {
  const client = useQueryClient()
  const id = completionId(conversationId ?? '', requestId ?? '', sessionGeneration())
  // The store notifies subscribers synchronously, so completion removes the animation in the event's render batch.
  return completions.use(client, ({ completed }) => completed.includes(id))
}

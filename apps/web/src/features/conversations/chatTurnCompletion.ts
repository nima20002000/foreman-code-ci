import { useQuery, type QueryClient } from '@tanstack/react-query'
import { sessionGeneration } from '../../shared/api/sessionBoundary'

const completionKey = (conversationId: string, requestId: string) =>
  ['chat-turn-completed', sessionGeneration(), conversationId, requestId] as const

/** Terminal notifications hide responding dots while the full snapshot is still being read.
 * Keep them in Query across reconnects and stale reads; they do not change command availability. */
export function markChatTurnCompleted(client: QueryClient, conversationId: string, requestId: string): void {
  client.setQueryData(completionKey(conversationId, requestId), true)
}

export function useChatTurnCompleted(conversationId: string | undefined, requestId: string | null | undefined): boolean {
  const { data } = useQuery<boolean>({
    queryKey: completionKey(conversationId ?? '', requestId ?? ''),
    enabled: false,
  })
  return data === true
}

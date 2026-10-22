import { useInfiniteQuery } from '@tanstack/react-query'
import type { DeliveryTarget } from '@foreman-code/contracts'
import { identityEpoch } from '../../../shared/api/protectedChatStorage'
import { isApiAccessError } from '../../../shared/api/accessError'
import { isApiRestartError } from '../../../shared/api/client'
import { chatDeliveryClient } from './client'

/** Original inputs that never reached a native message, newest page last. Nearly every chat has none. */
export function useRetainedInputs(target: DeliveryTarget, onDenied: (error: Error) => void, representedCommandIds?: readonly string[]) {
  const inputs = useInfiniteQuery({ queryKey: ['chat-delivery-inputs', identityEpoch(), JSON.stringify(target)],
    maxPages: 4, initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      try { return await chatDeliveryClient.inputs(target, { cursor: pageParam, limit: 25 }, { signal }) }
      catch (error) { if (isApiAccessError(error)) onDenied(error); throw error }
    }, getNextPageParam: page => page.nextCursor ?? undefined,
    // An app restart is not a failure worth showing; read again once it is back.
    refetchInterval: query => query.state.status === 'error' && isApiRestartError(query.state.error) ? 5_000 : false,
  })
  const represented = new Set(representedCommandIds)
  const items = [...(inputs.data?.pages ?? [])].reverse().flatMap(page => page.items)
    .filter(input => !represented.has(input.commandId))
  const restarting = inputs.isError && isApiRestartError(inputs.error)
  return { inputs, items, restarting }
}
export type RetainedInputsState = ReturnType<typeof useRetainedInputs>

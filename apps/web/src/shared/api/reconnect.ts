import { useEffect, useRef, useSyncExternalStore } from 'react'
import { onlineManager, useQuery, useQueryClient, type Query } from '@tanstack/react-query'
import { RuntimeIdentitySchema } from '@foreman-code/contracts'
import { ApiError, apiClient, isApiRestartError } from './client'
import { isTransientReadError } from './readFailure'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export const reconnectingMessage = 'Updating — reconnecting…'
const reconnectIntervalMs = 1_000

function needsReconnect(query: Query): boolean {
  return query.isActive() && (isApiRestartError(query.state.error) || isApiRestartError(query.state.fetchFailureReason))
}

function isRecoverableError(error: unknown): boolean {
  return isApiRestartError(error)
    || ApiError.is(error) && error.status >= 500 && isTransientReadError(error)
}

function needsRecovery(query: Query): boolean {
  return query.isActive()
    && (isRecoverableError(query.state.error) || isRecoverableError(query.state.fetchFailureReason))
}

/** Request failures stay in Query; recovery refreshes the other mounted reads too. */
export function useApiReconnect(): boolean {
  const client = useQueryClient()
  const cache = client.getQueryCache()
  const reconnecting = useSyncExternalStore(
    listener => cache.subscribe(listener),
    () => cache.getAll().some(needsReconnect),
  )
  const recovering = useSyncExternalStore(
    listener => cache.subscribe(listener),
    () => cache.getAll().some(needsRecovery),
  )
  const online = useSyncExternalStore(
    listener => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
  )
  // A paused query cannot discover reachability without an unpaused read.
  useQuery({
    queryKey: ['workbench', 'api-reachability', sessionGeneration()],
    enabled: !online && !sessionIsSwitching(),
    networkMode: 'always', retry: false, staleTime: 0, gcTime: 0,
    refetchInterval: reconnectIntervalMs, refetchIntervalInBackground: true,
    refetchOnReconnect: false, meta: { refetchOnApiReconnect: false },
    queryFn: async ({ signal }) => {
      const identity = await apiClient.request('/api/runtime/identity', RuntimeIdentitySchema, { signal })
      onlineManager.setOnline(true)
      return identity
    },
  })
  const wasReconnecting = useRef(false)
  useEffect(() => {
    if (!recovering && online) {
      if (wasReconnecting.current) void client.invalidateQueries({
        refetchType: 'active',
        predicate: query => query.meta?.refetchOnApiReconnect !== false,
      })
      wasReconnecting.current = false
      return
    }
    wasReconnecting.current = true
    if (!online) return
    const timer = window.setInterval(() => {
      void client.refetchQueries({ predicate: needsRecovery, type: 'active' }, { cancelRefetch: false })
    }, reconnectIntervalMs)
    return () => window.clearInterval(timer)
  }, [client, recovering, online])
  return reconnecting || !online
}

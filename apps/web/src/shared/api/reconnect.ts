import { useEffect, useRef, useSyncExternalStore } from 'react'
import { onlineManager, useQuery, useQueryClient, type Query, type QueryClient } from '@tanstack/react-query'
import { RuntimeIdentitySchema } from '@foreman-code/contracts'
import { ApiError, apiClient, isApiRestartError } from './client'
import { isTransientReadError } from './readFailure'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export const reconnectingMessage = 'Updating — reconnecting…'
const reconnectIntervalMs = 1_000

function needsReconnect(query: Query): boolean {
  // While a fresh read runs without a failure yet, its last restart error is stale: the first reads after a restart
  // can take many seconds. A new failure brings the notice back.
  const rereading = query.state.fetchStatus === 'fetching' && query.state.fetchFailureCount === 0
  return query.isActive() && query.meta?.refetchOnApiReconnect !== false
    && (isApiRestartError(query.state.fetchFailureReason) || !rereading && isApiRestartError(query.state.error))
}

function isRecoverableError(error: unknown): boolean {
  // A 5xx the API answered with its own error code is a domain failure (e.g. a harness that is signed out),
  // not a restart: polling it every second only makes its notice flicker.
  return isApiRestartError(error)
    || ApiError.is(error) && error.code === 'HTTP_ERROR' && (error.status ?? 0) >= 500 && isTransientReadError(error)
}

function needsRecovery(query: Query): boolean {
  return query.isActive() && query.meta?.refetchOnApiReconnect !== false
    && (isRecoverableError(query.state.error) || isRecoverableError(query.state.fetchFailureReason))
}

function hasPendingRetry(query: Query): boolean {
  return query.isActive() && query.meta?.refetchOnApiReconnect !== false
    && query.state.status === 'pending' && query.state.errorUpdateCount > 0
}

function canRefetchAfterReconnect(query: Query): boolean {
  return query.meta?.refetchOnApiReconnect !== false
    && (!query.state.error || isTransientReadError(query.state.error))
}

/** Reads every failed read again now. TanStack pauses retries while the tab is hidden, and a refetch of a query
 * without data only resumes its pending retry, so attempts that already failed are cancelled and read afresh. */
export async function retryApiReads(client: QueryClient): Promise<void> {
  const failed = client.getQueryCache().getAll().filter(needsRecovery)
  await Promise.all(failed.filter(query => query.state.fetchFailureCount > 0)
    .map(query => query.cancel({ revert: true })))
  await client.refetchQueries({ predicate: query => failed.includes(query), type: 'active' }, { cancelRefetch: false })
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
  const retrying = useSyncExternalStore(
    listener => cache.subscribe(listener),
    () => cache.getAll().some(hasPendingRetry),
  )
  const online = useSyncExternalStore(
    listener => onlineManager.subscribe(listener),
    () => onlineManager.isOnline(),
  )
  const probeFailed = useRef(false)
  // Probe independently of paused reads and identity retries waiting in backoff.
  useQuery({
    queryKey: ['workbench', 'api-reachability', sessionGeneration()],
    enabled: (recovering || !online) && !sessionIsSwitching(),
    // Every tick is a fresh request: a retry would pause in a hidden tab and every later tick would only wait on it.
    // A failed read re-enables the probe; a probe younger than one tick is not repeated then, or probe → reread →
    // failure → probe loops as fast as the requests answer.
    networkMode: 'always', retry: false, staleTime: reconnectIntervalMs, gcTime: 0,
    refetchInterval: reconnectIntervalMs, refetchIntervalInBackground: true,
    refetchOnReconnect: false, meta: { refetchOnApiReconnect: false },
    queryFn: async ({ signal }) => {
      let identity
      try {
        identity = await apiClient.request('/api/runtime/identity', RuntimeIdentitySchema, { signal })
      } catch (error) {
        probeFailed.current = true
        throw error
      }
      onlineManager.setOnline(true)
      // The API answers: read failed reads now instead of waiting out a retry backoff (up to 10 s) or a retry
      // paused in a hidden tab. A fresh read counts no failure until it fails, so a slow read is never restarted.
      void retryApiReads(client)
      if (probeFailed.current) {
        probeFailed.current = false
        void client.invalidateQueries({
          refetchType: 'active',
          predicate: canRefetchAfterReconnect,
        })
      }
      return identity
    },
  })
  const wasReconnecting = useRef(false)
  useEffect(() => {
    if (!recovering && online) {
      // A retry without cached data clears its error before a response arrives.
      if (retrying) return
      if (wasReconnecting.current) void client.invalidateQueries({
        refetchType: 'active',
        predicate: canRefetchAfterReconnect,
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
  }, [client, recovering, retrying, online])
  return reconnecting || !online
}

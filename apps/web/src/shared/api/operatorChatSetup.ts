import { useQuery } from '@tanstack/react-query'
import { OperatorChatSetupSchema, OperatorChatSetupQuerySchema, type OperatorChatSetupQuery, type OperatorChatSetup } from '@foreman-code/contracts'
import { apiClient } from './client'
import { sessionGeneration, sessionIsSwitching } from './sessionBoundary'

export function operatorChatSetupKey(revision?: number, target: OperatorChatSetupQuery = {}) {
  return ['operator-chat', 'setup', sessionGeneration(), { ...target, ...(revision === undefined ? {} : { expectedDefaultsRevision: revision }) }] as const
}

export function useOperatorChatSetup(enabled: boolean, revision?: number, target: OperatorChatSetupQuery = {}) {
  const query = { ...target, ...(revision === undefined ? {} : { expectedDefaultsRevision: revision }) }
  return useQuery<OperatorChatSetup>({ queryKey: operatorChatSetupKey(revision, target),
    enabled: enabled && !sessionIsSwitching(),
    staleTime: (query) => query.state.data?.status === 'configured' ? Infinity : 30_000,
    gcTime: Infinity, refetchOnWindowFocus: false,
    // A failed check retries on its own, so it recovers once the API is back.
    refetchInterval: (query) => query.state.status === 'error' ? 5_000 : query.state.data?.status === 'configured' ? false : 30_000,
    queryFn: ({ signal }) => {
      const parsed = OperatorChatSetupQuerySchema.parse(query)
      const parameters = new URLSearchParams()
      for (const [key, value] of Object.entries(parsed)) if (value !== undefined) parameters.set(key, String(value))
      return apiClient.request(`/api/operator/setup?${parameters}`, OperatorChatSetupSchema, { signal })
    },
  })
}

import type { PropsWithChildren } from 'react'
import { MutationCache, QueryCache, QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { retryTransientRead, transientRetryDelay } from '../shared/api/queryRetry'
import { reportAppError } from '../shared/api/appErrors'
import { ToastProvider } from '../shared/ui/nocturne'

const queryClient = new QueryClient({
  // Every failed read or command after its retries goes to the app error log.
  queryCache: new QueryCache({ onError: error => { reportAppError('query', error) } }),
  mutationCache: new MutationCache({ onError: error => { reportAppError('mutation', error) } }),
  defaultOptions: {
    queries: {
      retry: retryTransientRead,
      retryDelay: transientRetryDelay,
      staleTime: 30_000,
    },
  },
})

export function AppProviders({ children }: PropsWithChildren) {
  return <QueryClientProvider client={queryClient}><ToastProvider>{children}</ToastProvider></QueryClientProvider>
}

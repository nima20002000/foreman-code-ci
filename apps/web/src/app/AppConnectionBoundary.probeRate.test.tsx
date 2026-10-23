import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { server } from '../mocks/server'
import { mockRuntimeIdentity } from '../shared/mocks/handlers'
import { AppConnectionBoundary } from './AppConnectionBoundary'

let client: QueryClient

afterEach(() => {
  cleanup()
  client?.clear()
})

it('probes the API at most about once a second while a read keeps failing', async () => {
  let probes = 0
  server.use(
    // The cap only ends a runaway probe loop so the count can be asserted instead of hanging the test.
    http.get('/api/runtime/identity', () => ++probes > 50 ? HttpResponse.error() : HttpResponse.json(mockRuntimeIdentity)),
    http.get('/api/local-human', () => HttpResponse.error()),
  )
  client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  render(<QueryClientProvider client={client}><AppConnectionBoundary>
    <p>Connected page</p>
  </AppConnectionBoundary></QueryClientProvider>)
  expect(await screen.findByText('Updating — reconnecting…')).toBeInTheDocument()
  await act(() => new Promise(resolve => setTimeout(resolve, 2_500)))
  expect(probes).toBeLessThanOrEqual(4)
})

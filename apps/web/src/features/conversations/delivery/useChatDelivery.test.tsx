import type { ReactNode } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import type { EngineChatReadback } from '@foreman-code/contracts'
import { server } from '../../../mocks/server'
import { type DeliveryReadback } from './client'
import { useChatDelivery } from './useChatDelivery'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.useRealTimers() })

it.each(['execution', 'conversation'] as const)('returns a typed %s readback and polls until it becomes idle', async kind => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  const agent = agentChatFixtures.empty.context
  const engine: EngineChatReadback = { target: { kind: 'workflow_execution', agent,
    execution: { runId: 'run', workflowVersionId: 'version', executionId: 'execution', attempt: 1 } },
    state: 'active', capabilities: { steer: 'unavailable', queue: true, interruptAndSend: false },
    messages: [], receipts: [], nextCursor: null, hasMore: false, revision: 1 }
  const active: DeliveryReadback = kind === 'execution' ? engine : {
    target: { kind: 'agent_conversation', conversationId: 'conversation', agent }, state: agentChatFixtures.empty,
    receipts: [], delivery: { state: 'active', capabilities: engine.capabilities } }
  const idle: DeliveryReadback = 'delivery' in active
    ? { ...active, delivery: { ...active.delivery, state: 'idle' } } : { ...active, state: 'idle' }
  let response = active, reads = 0
  server.use(http.post(`/api/workspaces/${agent.workspaceId}/agent-chat/deliveries/read`, () => {
    reads++; return HttpResponse.json(response)
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  const wrapper = ({ children }: { children: ReactNode }) => <QueryClientProvider client={client}>{children}</QueryClientProvider>
  const { result } = renderHook(() => useChatDelivery(active.target, true, 'selected', undefined, { pollMs: 1000 }), { wrapper })
  await waitFor(() => expect(result.current.presentation.state).toBe('active'))
  const state: DeliveryReadback | undefined = result.current.state
  const data: DeliveryReadback | undefined = result.current.query.data
  expect(state).toEqual(active); expect(data).toEqual(active)
  const initialReads = reads
  response = idle
  await act(async () => { await vi.advanceTimersByTimeAsync(1100) })
  await waitFor(() => expect(result.current.presentation.state).toBe('idle'))
  expect(reads).toBeGreaterThan(initialReads)
  const settledReads = reads
  await act(async () => { await vi.advanceTimersByTimeAsync(2100) })
  expect(reads).toBe(settledReads)
})

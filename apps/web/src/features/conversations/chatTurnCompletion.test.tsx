import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, renderHook } from '@testing-library/react'
import type { ReactNode } from 'react'
import { expect, it } from 'vitest'
import { markChatTurnCompleted, useChatTurnCompleted } from '../chat-core'

const mount = (client: QueryClient) => ({ children }: { children: ReactNode }) =>
  <QueryClientProvider client={client}>{children}</QueryClientProvider>

it('hides the responding state for exactly the completed turn of one client', () => {
  const client = new QueryClient(), other = new QueryClient()
  const turn = renderHook(() => useChatTurnCompleted('conversation-1', 'request-1'), { wrapper: mount(client) })
  const nextTurn = renderHook(() => useChatTurnCompleted('conversation-1', 'request-2'), { wrapper: mount(client) })
  const elsewhere = renderHook(() => useChatTurnCompleted('conversation-1', 'request-1'), { wrapper: mount(other) })
  expect(turn.result.current).toBe(false)
  act(() => markChatTurnCompleted(client, 'conversation-1', 'request-1'))
  expect(turn.result.current).toBe(true)
  expect(nextTurn.result.current).toBe(false)
  expect(elsewhere.result.current).toBe(false)
})

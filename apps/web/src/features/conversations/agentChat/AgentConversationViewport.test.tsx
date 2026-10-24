import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import { installBrowserLocks } from '../../../test/browserLocks'
import { createAgentChatMock } from '../../../shared/mocks/agentChatHandlers'
import { useConversationDraftStore } from '../conversationDraftStore'
import { AgentConversation } from './AgentConversation'
import { LiveAgentConversation } from './LiveAgentConversation'
import { installChatSource } from './testSupport'

const clients: QueryClient[] = []
let restoreLocks: (() => void) | undefined
afterEach(() => {
  cleanup(); clients.splice(0).forEach(client => client.clear())
  useConversationDraftStore.getState().clearAllDrafts(); restoreLocks?.(); vi.unstubAllGlobals()
})

it.each([AgentConversation, LiveAgentConversation])('reads previous conversations inside the transcript while keeping the composer outside (%#)', async View => {
  installChatSource()
  restoreLocks = installBrowserLocks()
  const current = structuredClone(agentChatFixtures.idleAfterCompletion)
  const previous = structuredClone(current)
  previous.conversation!.id = 'previous-chat'
  current.conversation!.previousConversationId = previous.conversation!.id
  const path = `/api/workspaces/${current.context.workspaceId}/agent-chat/conversations/previous-chat`
  const mock = createAgentChatMock(current)
  const target = { kind: 'agent_conversation' as const, conversationId: current.conversation!.id, agent: {
    workspaceId: current.context.workspaceId, workflowId: current.context.workflowId,
    workflowNodeId: current.context.workflowNodeId, agentId: current.context.agentId,
  } }
  server.use(...mock.handlers)
  server.use(
    http.post(`/api/workspaces/${current.context.workspaceId}/agent-chat/deliveries/read`, async ({ request }) => {
      const body = await request.json() as { deliveryInputs?: unknown }
      return HttpResponse.json(body.deliveryInputs
        ? { target, deliveryInputs: { items: [], nextCursor: null, hasMore: false, revision: 0 } }
        : { target, state: current, receipts: [], delivery: { state: 'idle',
          capabilities: { steer: 'unavailable', queue: true, interruptAndSend: true } } })
    }),
    http.get(path, () => HttpResponse.json(previous)),
    http.get(`${path}/history`, () => HttpResponse.json({ conversationId: 'previous-chat', nextCursor: null,
      messages: [{ id: 'previous-message', conversationId: 'previous-chat', role: 'user', content: 'Earlier conversation content' }] })),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><View context={current.context} name="Coder" /></QueryClientProvider>)
  const previousConversation = await screen.findByText('Previous conversation')
  fireEvent.click(previousConversation)
  await screen.findByText('Earlier conversation content')
  const transcript = screen.getByRole('region', { name: 'Agent conversation transcript' })
  expect(within(transcript).getByText('Previous conversation')).toBeVisible()
  expect(within(transcript).getByText('Earlier conversation content')).toBeVisible()
  expect(transcript).not.toContainElement(screen.getByRole('group', { name: 'Chat actions' }))
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeEnabled()
})

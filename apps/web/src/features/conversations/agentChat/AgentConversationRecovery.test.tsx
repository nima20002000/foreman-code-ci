import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { agentChatFixtures, type SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import { installBrowserLocks } from '../../../test/browserLocks'
import { server } from '../../../mocks/server'
import { createAgentChatMock } from '../../../shared/mocks/agentChatHandlers'
import { useConversationDraftStore } from '../conversationDraftStore'
import { AgentConversation } from './AgentConversation'
import { LiveAgentConversation } from './LiveAgentConversation'
import { ephemeralFixture } from './f7.testSupport'

const clients: QueryClient[] = []
let restoreLocks: () => void
beforeEach(() => { localStorage.clear(); restoreLocks = installBrowserLocks() })
afterEach(() => { cleanup(); restoreLocks(); clients.splice(0).forEach(client => client.clear()); useConversationDraftStore.getState().clearAllDrafts() })

it.each([LiveAgentConversation, AgentConversation])('starts a separate conversation from a missing session without losing the unsent draft (%#)', async View => {
  const original = ephemeralFixture('restarted'), mock = createAgentChatMock(original)
  const previousId = original.conversation!.id, nativeSession = structuredClone(original.conversation!.nativeSession)
  const fresh = { ...structuredClone(agentChatFixtures.empty), context: original.context,
    conversation: { ...original.conversation!, id: 'fresh-chat', nativeSession: null, previousConversationId: previousId } }
  const commands: SendAgentChatMessageRequest[] = []
  server.use(...mock.handlers)
  server.use(http.post('/api/workspaces/:workspaceId/agent-chat/messages', async ({ request }) => {
    const command = await request.json() as SendAgentChatMessageRequest
    commands.push(command); mock.setState(fresh)
    return HttpResponse.json({ state: fresh, reset: { requestId: command.requestId, previousConversationId: previousId }, replayed: false })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><View context={original.context} name="Coder" /></QueryClientProvider>)
  await screen.findByText('Original session unavailable')
  const input = screen.getByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: 'Keep my unsent follow-up' } })
  fireEvent.click(screen.getByRole('button', { name: 'Start separate conversation' }))
  await waitFor(() => expect(commands).toHaveLength(1))
  expect(commands[0]).toMatchObject({ content: '/new', expectedConversationId: previousId })
  await waitFor(() => expect(screen.queryByText('Original session unavailable')).not.toBeInTheDocument())
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep my unsent follow-up')
  expect(screen.getByText('Previous conversation')).toBeInTheDocument()
  expect(original.conversation!.nativeSession).toEqual(nativeSession)
})

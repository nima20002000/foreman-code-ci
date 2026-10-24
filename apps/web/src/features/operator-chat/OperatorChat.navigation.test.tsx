import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { useConversationDraftStore } from '../conversations'
import { OperatorChat } from './OperatorChat'
import { installCanonicalOperatorFixture } from './canonicalOperator.test-support'
import { OperatorChatVisibilityProvider } from './visibility'
import { useOperatorChatStore } from './operatorChatStore'
import { operatorState } from './pr17-test-fixtures'
import { summarizeOperatorConversation } from './operatorChatStatus'

vi.mock('../../shared/api/operatorChatStream', () => ({ subscribeOperatorChat: () => () => {} }))
const clients: QueryClient[] = []
const states = ['one', 'two'].map(name => operatorState({
  conversation: { ...operatorState().conversation, id: `conversation-${name}`, title: `Chat ${name}` },
  turnState: 'idle', activeRequestId: null,
  messages: [{ id: `message-${name}`, conversationId: `conversation-${name}`, role: 'assistant', content: `Transcript ${name}` }],
}))

function mount(location = '/#operatorConversationId=conversation-one&selectedSubagentId=worker') {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  const root = createRootRoute({ component: () => <OperatorChatVisibilityProvider enabled><OperatorChat /></OperatorChatVisibilityProvider> })
  const index = createRoute({ getParentRoute: () => root, path: '/' })
  const router = createRouter({ routeTree: root.addChildren([index]), history: createMemoryHistory({ initialEntries: [location] }) })
  render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

beforeEach(() => {
  installCanonicalOperatorFixture()
  useConversationDraftStore.getState().clearAllDrafts()
  useOperatorChatStore.getState().reset()
  useOperatorChatStore.setState({ open: true, selectedConversationId: 'conversation-one' })
  server.use(
    http.get('/api/operator/conversations/summaries', () => HttpResponse.json({ conversations: states.map(summarizeOperatorConversation) })),
    http.get('/api/operator/conversations/:conversationId', ({ params }) => HttpResponse.json(states.find(state => state.conversation.id === params.conversationId))),
  )
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })

describe('Operator conversation destinations', () => {
  it('stays closed through unrelated Board navigation until the launcher is clicked', async () => {
    const router = mount()
    expect(await screen.findByText('Transcript one')).toBeVisible()
    fireEvent.click(screen.getByRole('button', { name: 'Close Operator chat' }))
    expect(await screen.findByRole('button', { name: 'Open Operator chat' })).toBeVisible()
    expect(screen.queryByRole('dialog', { name: 'Operator chat' })).not.toBeInTheDocument()
    for (const selectedSubagentId of ['another-worker', 'worker']) {
      await act(async () => { await router.navigate({ to: '/', hash: `operatorConversationId=conversation-one&selectedSubagentId=${selectedSubagentId}` }) })
      expect(screen.queryByRole('dialog', { name: 'Operator chat' })).not.toBeInTheDocument()
      expect(screen.getByRole('button', { name: 'Open Operator chat' })).toBeVisible()
    }
    fireEvent.click(screen.getByRole('button', { name: 'Open Operator chat' }))
    expect(await screen.findByRole('dialog', { name: 'Operator chat' })).toBeVisible()
    expect(await screen.findByText('Transcript one')).toBeVisible()
  })

  it('opens a copied conversation URL instead of the browser-local selection', async () => {
    useOperatorChatStore.setState({ open: false })
    mount('/#operatorConversationId=conversation-two')
    expect(await screen.findByRole('dialog', { name: 'Operator chat' })).toBeVisible()
    expect(await screen.findByText('Transcript two')).toBeVisible()
    expect(screen.queryByText('Transcript one')).not.toBeInTheDocument()
  })

  it('records history selections in the URL and restores conversations and drafts with browser Back', async () => {
    const router = mount()
    expect(await screen.findByText('Transcript one')).toBeVisible()
    fireEvent.change(await screen.findByRole('textbox', { name: 'Message' }), { target: { value: 'Keep my first draft' } })
    fireEvent.click(screen.getByRole('button', { name: 'Open history' }))
    const history = within(screen.getByRole('navigation', { name: 'Conversations' }))
    fireEvent.click(await history.findByRole('button', { name: /^Chat two/ }))
    expect(await screen.findByText('Transcript two')).toBeVisible()
    await waitFor(() => expect(new URLSearchParams(router.state.location.hash).get('operatorConversationId')).toBe('conversation-two'))
    expect(new URLSearchParams(router.state.location.hash).get('selectedSubagentId')).toBe('worker')
    await act(async () => router.history.back())
    expect(await screen.findByText('Transcript one')).toBeVisible()
    await waitFor(() => expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep my first draft'))
  })
})

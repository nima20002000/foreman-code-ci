import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import userEvent from '@testing-library/user-event'
import { server } from '../../mocks/server'
import { AppNavigationTrail } from '../../shared/ui/AppNavigationTrail'
import { AppNavigationHistoryContext } from '../../shared/ui/appNavigationHistoryContext'
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
  const root = createRootRoute({ component: () => <OperatorChatVisibilityProvider enabled><AppNavigationHistoryContext.Provider value={true}><Outlet /></AppNavigationHistoryContext.Provider><OperatorChat /></OperatorChatVisibilityProvider> })
  const index = createRoute({ getParentRoute: () => root, path: '/' })
  const workspaces = createRoute({ getParentRoute: () => root, path: '/workspaces', component: AppNavigationTrail })
  const board = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId', component: AppNavigationTrail })
  const router = createRouter({ routeTree: root.addChildren([index, workspaces, board]), history: createMemoryHistory({ initialEntries: [location] }) })
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
  it('keeps a dismissed chat closed after following the Workspaces breadcrumb and going Back to the Board', async () => {
    const user = userEvent.setup()
    const router = mount('/workspaces/workspace-1#operatorConversationId=conversation-one')
    expect(await screen.findByText('Transcript one')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Close Operator chat' }))
    expect(await screen.findByRole('button', { name: 'Open Operator chat' })).toBeVisible()
    await user.click(screen.getByRole('link', { name: 'Go to Workspaces' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces'))
    expect(router.state.location.hash).toBe('')
    expect(screen.queryByRole('dialog', { name: 'Operator chat' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back' }))
    await waitFor(() => expect(router.state.location.pathname).toBe('/workspaces/workspace-1'))
    expect(router.state.location.hash).toBe('operatorConversationId=conversation-one')
    expect(screen.queryByRole('dialog', { name: 'Operator chat' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open Operator chat' }))
    expect(await screen.findByText('Transcript one')).toBeVisible()
  })

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

  it.each(['/', '/#operatorConversationId=conversation-one'])('keeps the X closed after reloading %s', async (location) => {
    const user = userEvent.setup()
    const router = mount(location)
    expect(await screen.findByText('Transcript one')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Close Operator chat' }))
    expect(await screen.findByRole('button', { name: 'Open Operator chat' })).toBeVisible()
    expect(screen.queryByRole('dialog', { name: 'Operator chat' })).not.toBeInTheDocument()
    const reloadedLocation = `${router.state.location.pathname}#${router.state.location.hash}`
    cleanup()
    const reloaded = mount(reloadedLocation)
    await act(async () => { await reloaded.load() })
    expect(screen.queryByRole('dialog', { name: 'Operator chat' })).not.toBeInTheDocument()
    await act(async () => { await reloaded.navigate({ to: '/', hash: 'operatorConversationId=conversation-one&selectedSubagentId=another-worker' }) })
    expect(screen.queryByRole('dialog', { name: 'Operator chat' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Open Operator chat' }))
    expect(await screen.findByText('Transcript one')).toBeVisible()
    await user.click(screen.getByRole('button', { name: 'Close Operator chat' }))
    expect(await screen.findByRole('button', { name: 'Open Operator chat' })).toBeVisible()
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

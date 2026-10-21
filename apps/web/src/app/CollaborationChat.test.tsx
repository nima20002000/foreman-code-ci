import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { collaborationContractFixtures, type ChatSendRequest, type EngineChatReadback } from '@foreman-code/contracts'
import { server } from '../mocks/server'
import { useCollaborationUISlots } from '../shared/ui/collaborationSlots'
import { useConversationDraftStore } from '../features/conversations/conversationDraftStore'
import { workflowExecutionChatClient, executionChatReadKey } from '../features/workflow-hierarchy/execution-chat/client'
import { CollaborationFeatures } from './CollaborationFeatures'

const fixture = collaborationContractFixtures
const target = fixture.executionReadback.target
const root = '/api/workspaces/:workspaceId/agent-chat/deliveries'
const clients: QueryClient[] = []
class EventConnection extends EventTarget {
  static opened: EventConnection[] = []
  closed = false
  constructor(readonly url: string) { super(); EventConnection.opened.push(this) }
  close() { this.closed = true }
}
beforeEach(() => {
  EventConnection.opened = []
  vi.stubGlobal('EventSource', EventConnection)
  localStorage.clear()
  useConversationDraftStore.getState().clearAllDrafts()
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.unstubAllGlobals() })

function mount(state: EngineChatReadback['state'] = 'active') {
  if (target.kind !== 'workflow_execution') throw new Error('Expected execution fixture')
  const selectedTarget = target
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(cache)
  function BoardChat() {
    const View = useCollaborationUISlots()!.executionChatViews!.ExecutionChat
    return <View resolved={{ kind: 'selected', target: selectedTarget, agent: fixture.agent,
      workflowVersionId: fixture.execution.workflowVersionId, source: 'execution', state }}
      selection={{ ...fixture.node, runId: fixture.execution.runId, executionId: fixture.execution.executionId, limit: 50 }}
      queryKey={executionChatReadKey(selectedTarget)} client={workflowExecutionChatClient}
      onSelectTarget={() => {}} onSelectRun={() => {}} />
  }
  return render(<QueryClientProvider client={cache}><CollaborationFeatures><BoardChat /></CollaborationFeatures></QueryClientProvider>)
}
function endpoints(native = false) {
  const state = { value: { ...structuredClone(fixture.executionReadback),
    ...(native ? { nativeTurnId: 'current-owner-turn' } : {}) }, commands: [] as ChatSendRequest[] }
  server.use(http.post(`${root}/read`, async ({ request }) => {
    const input = await request.json() as { deliveryInputs?: unknown }
    if (input.deliveryInputs) return HttpResponse.json({ target, deliveryInputs: {
      items: [], nextCursor: null, hasMore: false, revision: state.value.revision } })
    return HttpResponse.json(state.value)
  }), http.post(`${root}/send`, async ({ request }) => {
    const input = await request.json() as ChatSendRequest
    state.commands.push(input)
    return HttpResponse.json({ id: 'steer-receipt', commandId: input.commandId, target, requestedIntent: input.intent,
      appliedIntent: 'steer', state: 'accepted', nativeTurnId: 'current-owner-turn',
      createdAt: '2026-10-01T00:00:00Z', updatedAt: '2026-10-01T00:00:00Z' })
  }))
  return state
}

it('enables Board steering from the observed owner turn and pins the sent command to it', async () => {
  const state = endpoints(true)
  mount()
  const composer = await screen.findByRole('textbox', { name: 'Message' })
  fireEvent.change(composer, { target: { value: 'Include the edge case' } })
  const send = await screen.findByRole('button', { name: 'Steer now' })
  await waitFor(() => expect(send).toBeEnabled())
  fireEvent.click(send)
  await waitFor(() => expect(state.commands).toHaveLength(1))
  expect(state.commands[0]).toMatchObject({ target, expectedNativeTurnId: 'current-owner-turn', content: 'Include the edge case' })
})

it('refreshes the visible production transcript for an exact native-message change without a hierarchy event', async () => {
  const state = endpoints()
  const view = mount()
  await screen.findByText('Working on the task.')
  const connection = EventConnection.opened.find(item => item.url.includes('/execution-chat/events'))
  expect(connection).toBeDefined()
  expect(JSON.parse(new URL(connection!.url, 'http://localhost').searchParams.get('target')!)).toEqual(target)
  state.value = { ...state.value, revision: state.value.revision + 1,
    messages: state.value.messages.map(message => ({ ...message, content: 'Still streaming while children work', revision: '2' })) }
  act(() => connection!.dispatchEvent(new MessageEvent('changed', { data: JSON.stringify({
    target, revision: state.value.revision, cursor: 'committed-text-2', snapshotRequired: true,
  }) })))
  await screen.findByText('Still streaming while children work')
  view.unmount()
  expect(connection!.closed).toBe(true)
})

it('opens historical follow-up with the selected source execution retained', async () => {
  const state = endpoints()
  state.value = { ...state.value, state: 'idle', capabilities: { steer: 'unavailable', queue: false, interruptAndSend: false } }
  const selections: URL[] = []
  server.use(http.get('/api/workspaces/:workspaceId/agent-chat/workflows/:workflowId/runs/:runId/nodes/:nodeId', ({ request }) => {
    selections.push(new URL(request.url))
    return HttpResponse.json({ error: { code: 'SOURCE_UNAVAILABLE', message: 'Source unavailable' } }, { status: 409 })
  }))
  mount('idle')
  fireEvent.click(await screen.findByRole('button', { name: 'Follow up in Agent chat' }))
  await waitFor(() => expect(selections).toHaveLength(1))
  expect(selections[0]!.pathname).toBe(`/api/workspaces/${fixture.node.workspaceId}/agent-chat/workflows/${fixture.node.workflowId}`
    + `/runs/${fixture.execution.runId}/nodes/${fixture.node.workflowNodeId}`)
  expect(selections[0]!.searchParams.get('executionId')).toBe(fixture.execution.executionId)
  expect(state.commands).toEqual([])
})

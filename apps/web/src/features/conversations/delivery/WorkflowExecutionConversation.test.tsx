import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { collaborationContractFixtures as fixture, WorkflowExecutionChatResolutionSchema, WorkflowExecutionChatSelectionSchema } from '@foreman-code/contracts'
import { AgentChatStateSchema, agentChatFixtures } from '@foreman-code/contracts/agent-chat'
import { agentChatFixtureFor, createAgentChatMock } from '../../../shared/mocks/agentChatHandlers'
import { useConversationDraftStore } from '../conversationDraftStore'
import { agentChatDraftKey } from '../agentChat/model'
import { installBrowserLocks } from '../../../test/browserLocks'
import { server } from '../../../mocks/server'
import { executionChatReadKey } from '../../workflow-hierarchy'
import { WorkflowExecutionConversation } from './WorkflowExecutionConversation'

const clients: QueryClient[] = []
let restoreLocks: () => void
beforeEach(() => { localStorage.clear(); restoreLocks = installBrowserLocks() })
afterEach(() => { cleanup(); restoreLocks(); clients.splice(0).forEach(client => client.clear()); useConversationDraftStore.getState().clearAllDrafts() })

it('keeps the attachment affordance visible with the active execution restriction', async () => {
  const resolved = WorkflowExecutionChatResolutionSchema.parse({ kind: 'selected', target: fixture.executionReadback.target,
    agent: fixture.agent, workflowVersionId: fixture.execution.workflowVersionId, source: 'execution', state: 'active' })
  if (resolved.kind !== 'selected') throw new Error('Expected selected execution')
  server.use(http.post('*/agent-chat/deliveries/read', async ({ request }) => {
    const body = await request.json() as { deliveryInputs?: unknown }
    return HttpResponse.json(body.deliveryInputs ? { target: resolved.target,
      deliveryInputs: { items: [], nextCursor: null, hasMore: false, revision: 1 } } : fixture.executionReadback)
  }))
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(cache)
  render(<QueryClientProvider client={cache}><WorkflowExecutionConversation resolved={resolved}
    selection={WorkflowExecutionChatSelectionSchema.parse({ workspaceId: fixture.node.workspaceId, workflowId: fixture.node.workflowId, workflowNodeId: fixture.node.workflowNodeId })}
    queryKey={executionChatReadKey(resolved.target)} client={{ read: vi.fn(), deliver: vi.fn(), stop: vi.fn(), cancel: vi.fn() }}
    onSelectTarget={vi.fn()} onSelectRun={vi.fn()} /></QueryClientProvider>)
  await screen.findByRole('textbox', { name: 'Message' })
  const attach = screen.getByRole('button', { name: 'Attach files' })
  expect(attach).toBeDisabled()
  fireEvent.mouseEnter(attach.parentElement!)
  expect(screen.getByRole('tooltip')).toHaveTextContent('Files can be attached after this execution finishes.')
})

function attachmentGeometry() {
  const attach = screen.getByRole('button', { name: 'Attach files' })
  const form = screen.getByRole('form', { name: 'Conversation composer' })
  let slot: HTMLElement = attach
  while (slot.parentElement !== form.querySelector('.agent-chat-input-box')) {
    if (getComputedStyle(slot.parentElement!).display === 'contents') break
    slot = slot.parentElement!
  }
  const style = getComputedStyle(slot)
  return { row: style.gridRow, column: style.gridColumn, width: style.width, height: style.height }
}

it('places the unavailable attachment control beside the active message field', async () => {
  const resolved = WorkflowExecutionChatResolutionSchema.parse({ kind: 'selected', target: fixture.executionReadback.target,
    agent: fixture.agent, workflowVersionId: fixture.execution.workflowVersionId, source: 'execution', state: 'active' })
  if (resolved.kind !== 'selected') throw new Error('Expected selected execution')
  server.use(http.post('*/agent-chat/deliveries/read', async ({ request }) => {
    const body = await request.json() as { deliveryInputs?: unknown }
    return HttpResponse.json(body.deliveryInputs ? { target: resolved.target,
      deliveryInputs: { items: [], nextCursor: null, hasMore: false, revision: 1 } } : fixture.executionReadback)
  }))
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(cache)
  render(<QueryClientProvider client={cache}><WorkflowExecutionConversation resolved={resolved}
    selection={WorkflowExecutionChatSelectionSchema.parse({ workspaceId: fixture.node.workspaceId, workflowId: fixture.node.workflowId, workflowNodeId: fixture.node.workflowNodeId })}
    queryKey={executionChatReadKey(resolved.target)} client={{ read: vi.fn(), deliver: vi.fn(), stop: vi.fn(), cancel: vi.fn() }}
    onSelectTarget={vi.fn()} onSelectRun={vi.fn()} /></QueryClientProvider>)
  await screen.findByRole('textbox', { name: 'Message' })
  expect(attachmentGeometry()).toMatchObject({ row: '2', column: '1', width: '28px', height: '28px' })
})

it('keeps attachment geometry and the typed draft when the execution finishes', async () => {
  const resolved = WorkflowExecutionChatResolutionSchema.parse({ kind: 'selected', target: fixture.executionReadback.target,
    agent: fixture.agent, workflowVersionId: fixture.execution.workflowVersionId, source: 'execution', state: 'active' })
  if (resolved.kind !== 'selected' || resolved.target.kind !== 'workflow_execution') throw new Error('Expected selected execution')
  const target = resolved.target, context = { ...target.agent, runId: target.execution.runId }
  const selection = { workspaceId: context.workspaceId, workflowId: context.workflowId,
    workflowNodeId: context.workflowNodeId, runId: context.runId, executionId: target.execution.executionId }
  const followUp = agentChatFixtureFor(agentChatFixtures.idleAfterCompletion, context)
  if (!followUp.conversation || followUp.conversation.origin.kind !== 'run_execution') throw new Error('Expected Run conversation')
  followUp.conversation.origin.executionId = target.execution.executionId
  const mock = createAgentChatMock(followUp)
  let finished = false
  server.use(...mock.handlers, http.get('*/agent-chat/workflows/:workflowId/runs/:runId/nodes/:workflowNodeId', () =>
    HttpResponse.json({ kind: 'selected', selection,
      key: { ...context, executionId: target.execution.executionId, conversationId: followUp.conversation!.id }, state: followUp })),
  http.post('*/agent-chat/deliveries/read', async ({ request }) => {
    const body = await request.json() as { deliveryInputs?: unknown }
    return HttpResponse.json(body.deliveryInputs ? { target, deliveryInputs: { items: [], nextCursor: null, hasMore: false, revision: 1 } }
      : { ...fixture.executionReadback, ...(finished ? { state: 'idle', capabilities: { steer: 'unavailable', queue: false, interruptAndSend: false } } : {}) })
  }))
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(cache)
  render(<QueryClientProvider client={cache}><WorkflowExecutionConversation resolved={resolved} selection={WorkflowExecutionChatSelectionSchema.parse(selection)}
    queryKey={executionChatReadKey(target)} client={{ read: vi.fn(), deliver: vi.fn(), stop: vi.fn(), cancel: vi.fn() }}
    onSelectTarget={vi.fn()} onSelectRun={vi.fn()} /></QueryClientProvider>)
  const input = await screen.findByRole('textbox', { name: 'Message' })
  fireEvent.change(input, { target: { value: 'Keep this question' } })
  const active = attachmentGeometry()
  finished = true
  await waitFor(() => expect(screen.getByTestId('agent-conversation')).toBeInTheDocument(), { timeout: 6000 })
  expect(screen.getByRole('textbox', { name: 'Message' })).toHaveValue('Keep this question')
  expect(attachmentGeometry()).toEqual(active)
}, 15_000)

it('opens a separate supported chat when a finished Run has no resumable session or conversation', async () => {
  const resolved = WorkflowExecutionChatResolutionSchema.parse({ kind: 'selected', target: fixture.executionReadback.target,
    agent: fixture.agent, workflowVersionId: fixture.execution.workflowVersionId, source: 'execution', state: 'idle' })
  if (resolved.kind !== 'selected' || resolved.target.kind !== 'workflow_execution') throw new Error('Expected selected execution')
  const target = resolved.target, context = { ...target.agent, runId: target.execution.runId }
  const selection = { workspaceId: context.workspaceId, workflowId: context.workflowId,
    workflowNodeId: context.workflowNodeId, runId: context.runId, executionId: target.execution.executionId }
  const unavailable = AgentChatStateSchema.parse({ ...agentChatFixtureFor(agentChatFixtures.empty, context),
    sourceTranscript: { executionId: target.execution.executionId, state: 'completed', revision: '1',
      messages: [], hasEarlierMessages: false },
    availability: { canSend: false, reason: 'native_session_missing', message: 'This execution has no resumable stored native session.' } })
  const outside = createAgentChatMock(agentChatFixtureFor(agentChatFixtures.empty, target.agent))
  server.use(...outside.handlers)
  server.use(http.get('*/agent-chat/workflows/:workflowId/runs/:runId/nodes/:workflowNodeId', () =>
    HttpResponse.json({ kind: 'selected', selection, key: null, state: unavailable })),
  http.post('*/agent-chat/deliveries/read', async ({ request }) => {
    const body = await request.json() as { deliveryInputs?: unknown }
    return HttpResponse.json(body.deliveryInputs ? { target, deliveryInputs: { items: [], nextCursor: null, hasMore: false, revision: 1 } }
      : { ...fixture.executionReadback, state: 'idle', capabilities: { steer: 'unavailable', queue: false, interruptAndSend: false } })
  }))
  const draftKey = agentChatDraftKey(context, target.execution.executionId)
  useConversationDraftStore.getState().setDraft(draftKey, 'Original Run draft')
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(cache)
  render(<QueryClientProvider client={cache}><WorkflowExecutionConversation resolved={resolved} selection={WorkflowExecutionChatSelectionSchema.parse(selection)}
    queryKey={executionChatReadKey(target)} client={{ read: vi.fn(), deliver: vi.fn(), stop: vi.fn(), cancel: vi.fn() }}
    onSelectTarget={vi.fn()} onSelectRun={vi.fn()} /></QueryClientProvider>)
  await screen.findByText('Original session unavailable')
  fireEvent.click(screen.getByRole('button', { name: 'Start separate chat without this Run' }))
  expect(await screen.findByText('Separate chat outside this Run')).toBeInTheDocument()
  expect(await screen.findByRole('textbox', { name: 'Message' })).not.toBeDisabled()
  expect(outside.calls.filter(call => call.method === 'POST' && call.path.endsWith('/messages'))).toHaveLength(0)
  fireEvent.click(screen.getByRole('button', { name: 'Back to Run chat' }))
  expect(await screen.findByRole('textbox', { name: 'Message' })).toHaveValue('Original Run draft')
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { collaborationContractFixtures as fixture, WorkflowExecutionChatResolutionSchema } from '@foreman-code/contracts'
import { server } from '../../../mocks/server'
import { executionChatReadKey } from '../../workflow-hierarchy/execution-chat/client'
import { WorkflowExecutionConversation } from './WorkflowExecutionConversation'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })

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
    selection={{ workspaceId: fixture.node.workspaceId, workflowId: fixture.node.workflowId, workflowNodeId: fixture.node.workflowNodeId }}
    queryKey={executionChatReadKey(resolved.target)} client={{ read: vi.fn(), deliver: vi.fn(), stop: vi.fn(), cancel: vi.fn() }}
    onSelectTarget={vi.fn()} onSelectRun={vi.fn()} /></QueryClientProvider>)
  await screen.findByRole('textbox', { name: 'Message' })
  const attach = screen.getByRole('button', { name: 'Attach files' })
  expect(attach).toBeDisabled()
  fireEvent.mouseEnter(attach.parentElement!)
  expect(screen.getByRole('tooltip')).toHaveTextContent('Files can be attached after this execution finishes.')
})

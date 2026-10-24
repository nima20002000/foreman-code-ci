import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { createMemoryBoardClient } from './client'
import { MemoryCardDetail } from './MemoryCardDetail'
import { createMemoryBoardHandlers } from './mocks'
import { createMemoryTestPort, memoryTestCard, memoryTestIds, memoryTestTime } from './testing'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })

it('distinguishes prefixed run and execution identities in linked work and history with exact identities on hover', async () => {
  const memory = createMemoryTestPort({ cards: [memoryTestCard()] })
  const node = { workspaceId: memoryTestIds.workspace, workflowId: memoryTestIds.workflow, workflowNodeId: 'worker-node', agentId: 'worker-agent' }
  const runs = ['run-4339abcd-full', 'run-5374efgh-full']
  const executions = ['execution-aabbccdd-full', 'execution-eeff0011-full']
  memory.control.bindings = runs.map((runId, index) => ({ id: `binding-${index}`, cardId: memoryTestIds.card, node,
    work: { kind: 'slot', runId, workflowVersionId: 'saved-version', slotId: `slot-${index}` },
    currentExecutionId: executions[index]!, state: 'accepted', reason: null, revision: 1 }))
  memory.control.history = runs.map((runId, index) => ({ id: `change-${index}`, boardId: memoryTestIds.board,
    sequence: index + 1, boardRevision: 1, entity: 'card', entityId: memoryTestIds.card, entityRevision: 1,
    actor: { kind: 'agent', id: 'worker-agent', displayName: 'Worker' }, occurredAt: memoryTestTime,
    provenance: { execution: { runId, workflowVersionId: 'saved-version', executionId: executions[index]!, attempt: index + 1 } } }))
  server.use(...createMemoryBoardHandlers(memory.port))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const onOpenWork = vi.fn(), onOpenHistoryWork = vi.fn()
  render(<QueryClientProvider client={client}><MemoryCardDetail client={createMemoryBoardClient()}
    boardId={memoryTestIds.board} cardId={memoryTestIds.card} nodes={[{ node, label: 'Worker', available: true, currentWork: [] }]}
    health={[]} canWrite onBack={vi.fn()} onEdit={vi.fn()} onOpenWork={onOpenWork} onOpenHistoryWork={onOpenHistoryWork} /></QueryClientProvider>)
  await screen.findByRole('heading', { name: 'Prepare release notes' })
  expect(screen.getByText('Run 4339abcd', { exact: false })).toBeVisible()
  expect(screen.getByText('Run 5374efgh', { exact: false })).toBeVisible()
  expect(screen.getByTitle(runs[0]!)).toHaveTextContent('Run 4339abcd')
  expect(screen.getByTitle(executions[0]!)).toHaveTextContent('Execution aabbccdd')
  await userEvent.click(screen.getAllByRole('button', { name: 'Open work' })[0]!)
  expect(onOpenWork).toHaveBeenCalledWith(memory.control.bindings[0])
  await userEvent.click(screen.getByRole('button', { name: 'History' }))
  for (const [index, entry] of memory.control.history.entries()) {
    const row = screen.getAllByRole('button', { name: 'Open recorded work' })[index]!.closest('li')!
    expect(within(row).getByTitle(runs[index]!)).toHaveTextContent(`Run ${index === 0 ? '4339abcd' : '5374efgh'}`)
    expect(within(row).getByTitle(executions[index]!)).toHaveTextContent(`Execution ${index === 0 ? 'aabbccdd' : 'eeff0011'} · attempt ${index + 1}`)
    await userEvent.click(within(row).getByRole('button', { name: 'Open recorded work' }))
    expect(onOpenHistoryWork).toHaveBeenLastCalledWith(entry)
  }
})

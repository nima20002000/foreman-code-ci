import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { createMemoryBoardHandlers } from '../memory-boards/mocks'
import { createMemoryTestPort, memoryTestCard, memoryTestIds } from '../memory-boards/testing'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { installBoardTestLifecycle, mountMeasuredBoard } from './eng05D.testSupport'

installBoardTestLifecycle()

it('closes Memory before opening its exact linked work through the production route guard', async () => {
  vi.stubGlobal('EventSource', undefined)
  const fixture = await inspectionBoardFixture('memory-open-work')
  const saved = fixture.runs.before.scope
  const node = fixture.first
  const memory = createMemoryTestPort({ cards: [memoryTestCard()], scope: {
    kind: 'workflow', workspaceId: saved.workspaceId, workflowId: saved.workflowId,
  } })
  memory.control.bindings = [{ id: 'binding', cardId: memoryTestIds.card,
    node: { workspaceId: saved.workspaceId, workflowId: saved.workflowId, workflowNodeId: node.id, agentId: node.agentId },
    work: { kind: 'activation', runId: saved.runId, workflowVersionId: saved.workflowVersionId, activationId: 'activation' },
    currentExecutionId: fixture.ordinaryExecutions[0]!.detail.execution.executionId, state: 'accepted', reason: null, revision: 1 }]
  server.use(...fixture.mock.handlers, ...createMemoryBoardHandlers(memory.port))
  const { router } = await mountMeasuredBoard(`/workspaces/${saved.workspaceId}?workflowId=${saved.workflowId}&boardMemory=true&memoryCard=${memoryTestIds.card}`)
  const dialog = await screen.findByRole('dialog', { name: 'Memory board' })
  await userEvent.click(await within(dialog).findByRole('button', { name: 'Open work' }))
  await waitFor(() => expect(router.state.location.search.selectedRunId).toBe(saved.runId))
  expect(screen.queryByRole('dialog', { name: 'Memory board' })).not.toBeInTheDocument()
  expect(router.state.location.search.boardExecutionId).toBe(memory.control.bindings[0]!.currentExecutionId)
}, 15_000)

it('opens the exact Run and execution recorded in Memory history after closing its dialog', async () => {
  vi.stubGlobal('EventSource', undefined)
  const fixture = await inspectionBoardFixture('memory-history-work')
  const saved = fixture.runs.before.scope, node = fixture.first
  const executionId = fixture.ordinaryExecutions[0]!.detail.execution.executionId
  const memory = createMemoryTestPort({ cards: [memoryTestCard()], scope: {
    kind: 'workflow', workspaceId: saved.workspaceId, workflowId: saved.workflowId,
  } })
  memory.control.history = [{ id: 'history', boardId: memoryTestIds.board, sequence: 1, boardRevision: 1,
    entity: 'card', entityId: memoryTestIds.card, entityRevision: 1,
    actor: { kind: 'agent', id: node.agentId, displayName: 'Recorded Agent' }, occurredAt: '2026-10-20T20:00:00.000Z',
    provenance: { work: { kind: 'activation', runId: saved.runId, workflowVersionId: saved.workflowVersionId, activationId: 'activation' },
      execution: { runId: saved.runId, workflowVersionId: saved.workflowVersionId, executionId, attempt: 1 },
      subject: { kind: 'execution', agent: { workspaceId: saved.workspaceId, workflowId: saved.workflowId,
        workflowNodeId: node.id, agentId: node.agentId, productRole: 'coder', displayName: 'Recorded Agent', configurationVersionId: 'config' },
        execution: { runId: saved.runId, workflowVersionId: saved.workflowVersionId, executionId, attempt: 1 } } } }]
  server.use(...fixture.mock.handlers, ...createMemoryBoardHandlers(memory.port))
  const { router } = await mountMeasuredBoard(`/workspaces/${saved.workspaceId}?workflowId=${saved.workflowId}&boardMemory=true&memoryCard=${memoryTestIds.card}`)
  const dialog = await screen.findByRole('dialog', { name: 'Memory board' })
  await userEvent.click(await within(dialog).findByRole('button', { name: 'History' }))
  await userEvent.click(within(dialog).getByRole('button', { name: 'Open recorded work' }))
  await waitFor(() => expect(router.state.location.search.selectedRunId).toBe(saved.runId))
  expect(router.state.location.search.boardExecutionId).toBe(executionId)
  expect(router.state.location.search.boardNodeId).toBe(node.id)
  expect(screen.queryByRole('dialog', { name: 'Memory board' })).not.toBeInTheDocument()
}, 15_000)

it.each(['engine', 'agent'] as const)('opens recorded execution history from the %s producer through the mounted Board', async producer => {
  vi.stubGlobal('EventSource', undefined)
  const fixture = await inspectionBoardFixture(`memory-history-${producer}`)
  const saved = fixture.runs.before.scope, node = fixture.first
  const executionId = fixture.ordinaryExecutions[1]!.detail.execution.executionId
  const execution = { runId: saved.runId, workflowVersionId: saved.workflowVersionId, executionId, attempt: 2 }
  const memory = createMemoryTestPort({ cards: [memoryTestCard()], scope: {
    kind: 'workflow', workspaceId: saved.workspaceId, workflowId: saved.workflowId,
  } })
  memory.control.history = [{ id: 'history', boardId: memoryTestIds.board, sequence: 1, boardRevision: 1,
    entity: 'card', entityId: memoryTestIds.card, entityRevision: 1,
    actor: { kind: producer, id: node.agentId, displayName: 'Recorded Agent' }, occurredAt: '2026-10-20T20:00:00.000Z',
    provenance: producer === 'engine'
      ? { work: { kind: 'activation', runId: saved.runId, workflowVersionId: saved.workflowVersionId, activationId: 'activation' }, execution }
      : { subject: { kind: 'execution', agent: { workspaceId: saved.workspaceId, workflowId: saved.workflowId,
        workflowNodeId: node.id, agentId: node.agentId, productRole: 'coder', displayName: 'Recorded Agent', configurationVersionId: 'config' }, execution } } }]
  server.use(...fixture.mock.handlers, ...createMemoryBoardHandlers(memory.port))
  const { router } = await mountMeasuredBoard(`/workspaces/${saved.workspaceId}?workflowId=${saved.workflowId}&boardMemory=true&memoryCard=${memoryTestIds.card}`)
  const dialog = await screen.findByRole('dialog', { name: 'Memory board' })
  await userEvent.click(await within(dialog).findByRole('button', { name: 'History' }))
  await userEvent.click(within(dialog).getByRole('button', { name: 'Open recorded work' }))
  await waitFor(() => expect(router.state.location.search.selectedRunId).toBe(saved.runId))
  expect(router.state.location.search.boardExecutionId).toBe(executionId)
  expect(router.state.location.search.boardNodeId).toBe(node.id)
  expect(screen.queryByRole('dialog', { name: 'Memory board' })).not.toBeInTheDocument()
  const rail = await screen.findByRole('complementary', { name: 'Workflow side panel' })
  expect(await within(rail).findByRole('article', { name: `Execution ${executionId}` })).toBeVisible()
}, 15_000)

it('keeps Memory open with a readable error when the recorded execution cannot be resolved', async () => {
  vi.stubGlobal('EventSource', undefined)
  const fixture = await inspectionBoardFixture('memory-history-unavailable')
  const saved = fixture.runs.before.scope
  const execution = { runId: saved.runId, workflowVersionId: saved.workflowVersionId,
    executionId: 'unavailable-execution', attempt: 1 }
  const memory = createMemoryTestPort({ cards: [memoryTestCard()], scope: {
    kind: 'workflow', workspaceId: saved.workspaceId, workflowId: saved.workflowId,
  } })
  memory.control.history = [{ id: 'history', boardId: memoryTestIds.board, sequence: 1, boardRevision: 1,
    entity: 'card', entityId: memoryTestIds.card, entityRevision: 1,
    actor: { kind: 'engine', id: fixture.first.agentId, displayName: 'Recorded Agent' }, occurredAt: '2026-10-20T20:00:00.000Z',
    provenance: { work: { kind: 'activation', runId: saved.runId, workflowVersionId: saved.workflowVersionId, activationId: 'activation' }, execution } }]
  server.use(...fixture.mock.handlers, ...createMemoryBoardHandlers(memory.port),
    http.get(`*/api/management/workspaces/${saved.workspaceId}/runs/${saved.runId}/executions/${execution.executionId}`,
      () => HttpResponse.json({ error: { code: 'NOT_FOUND', message: 'Recorded execution is unavailable.' } }, { status: 404 })))
  const { router } = await mountMeasuredBoard(`/workspaces/${saved.workspaceId}?workflowId=${saved.workflowId}&boardMemory=true&memoryCard=${memoryTestIds.card}`)
  const dialog = await screen.findByRole('dialog', { name: 'Memory board' })
  await userEvent.click(await within(dialog).findByRole('button', { name: 'History' }))
  await userEvent.click(within(dialog).getByRole('button', { name: 'Open recorded work' }))
  expect(await within(dialog).findByRole('alert')).toHaveTextContent('Recorded work could not be opened.')
  expect(dialog).toBeVisible()
  expect(router.state.location.search.selectedRunId).toBeUndefined()
}, 15_000)

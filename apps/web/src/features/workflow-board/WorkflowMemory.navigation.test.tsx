import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { createMemoryBoardHandlers } from '../memory-boards/mocks'
import { createMemoryTestPort, memoryTestCard, memoryTestIds } from '../memory-boards/testing'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { installBoardTestLifecycle, mountMeasuredBoard } from './eng05D.testSupport'

installBoardTestLifecycle()

it('closes Memory before opening its exact linked work through the production route guard', async () => {
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

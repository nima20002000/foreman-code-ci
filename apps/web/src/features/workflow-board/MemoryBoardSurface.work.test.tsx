import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { LocalHumanAccessSchema } from '@foreman-code/contracts/management'
import { expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { RunsSelectorSearchSchema } from '../runs-selector'
import { createMemoryBoardHandlers } from '../memory-boards/mocks'
import { createMemoryTestPort } from '../memory-boards/testing'
import { MemoryBoardSurface } from './MemoryBoardSurface'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { installBoardTestLifecycle, newBoardQueryClient, setRunState } from './eng05D.testSupport'

installBoardTestLifecycle()

it.each([
  { kind: 'workflow', state: 'running' }, { kind: 'workspace', state: 'running' },
  { kind: 'workflow', state: 'completed' }, { kind: 'workspace', state: 'completed' },
] as const)('offers exact current work in $kind Memory when its native attempt is $state', async ({ kind, state }) => {
  vi.stubGlobal('EventSource', undefined)
  const fixture = await inspectionBoardFixture(`memory-work-${kind}`)
  const saved = fixture.runs.before.scope
  setRunState(fixture, saved, 'running')
  const scope = kind === 'workflow' ? { kind, workspaceId: saved.workspaceId, workflowId: saved.workflowId }
    : { kind, workspaceId: saved.workspaceId }
  const memory = createMemoryTestPort({ scope })
  memory.board.id = crypto.randomUUID()
  const detail = fixture.ordinaryExecutions[1]!.detail
  const logicalWork = { kind: 'slot', runId: saved.runId, workflowVersionId: saved.workflowVersionId, slotId: 'current-slot' }
  server.use(...fixture.mock.handlers, ...createMemoryBoardHandlers(memory.port))
  server.use(
    http.get('/api/local-human', () => HttpResponse.json(LocalHumanAccessSchema.parse({ principal: {
      id: 'memory-writer', name: 'Memory writer', expiresAt: '2099-01-01T00:00:00.000Z',
      grants: [{ actions: ['workspaces:read', 'workspaces:update', 'workflows:read', 'workflows:update', 'runs:read'], scope: { workspaceIds: [saved.workspaceId] } }],
    } }))),
    http.get(`*/api/management/workspaces/${saved.workspaceId}/runs/${saved.runId}/executions`, () => HttpResponse.json({
      run: { ...detail.run, executionState: 'running', outcome: 'pending' },
      items: [{ ...detail.execution, state, acceptedResultAvailable: false,
        finishedAt: state === 'completed' ? detail.execution.finishedAt : undefined, logicalWork }], pageInfo: { nextCursor: null },
    })))
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: kind === 'workspace' ? '/workspaces/$workspaceId/memory' : '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema.parse, component: () => <MemoryBoardSurface scope={scope} scopeName="Test" /> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({
    initialEntries: [kind === 'workspace' ? `/workspaces/${saved.workspaceId}/memory` : `/workspaces/${saved.workspaceId}?workflowId=${saved.workflowId}`],
  }) })
  await router.load()
  render(<QueryClientProvider client={newBoardQueryClient()}><RouterProvider router={router} /></QueryClientProvider>)
  const user = userEvent.setup()
  const add = await screen.findByRole('button', { name: 'Add card' })
  await waitFor(() => expect(add).toBeEnabled())
  await user.click(add)
  await user.type(screen.getByRole('textbox', { name: 'Title' }), 'Track current work')
  await user.click(await screen.findByRole('checkbox', { name: fixture.first.name! }))
  const current = await screen.findByRole('checkbox', { name: /Current work/ })
  await user.click(current)
  expect(screen.getByRole('checkbox', { name: /Next activation/ })).not.toBeChecked()
  await user.click(screen.getByRole('button', { name: 'Create card' }))
  await waitFor(() => expect(memory.calls).toContainEqual({ method: 'mutate', value: expect.objectContaining({
    kind: 'card_create', workSelections: [{ kind: 'current', work: logicalWork }],
  }) }))
}, 20_000)

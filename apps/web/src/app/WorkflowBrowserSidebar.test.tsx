import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { BrowserSession } from '@foreman-code/contracts'
import { currentWorkflowFixture } from '../shared/mocks/currentWorkflow'
import { server } from '../mocks/server'
import { browserRead, subject } from '../features/agent-browser/testFixtures'
import { RunsSelectorSearchSchema } from '../features/runs-selector'
import { useBrowserSidebarTabs } from '../features/workflow-board'
import { installBoardTestLifecycle, newBoardQueryClient } from '../features/workflow-board/eng05D.testSupport'
import { WorkflowBrowserSidebar } from './WorkflowBrowserSidebar'

installBoardTestLifecycle()

async function mountSidebar(options: { startedAt?: string; runtime?: unknown } = {}) {
  useBrowserSidebarTabs.setState({ opened: {}, closed: {} })
  const sessions: BrowserSession[] = [
    { ...browserRead('chat-session').session, subject: { kind: 'conversation', agent: subject.agent, conversationId: 'conversation' } },
    { ...browserRead('run-session').session, ...(options.startedAt ? { startedAt: options.startedAt } : {}) },
    { ...browserRead('retry-session').session, subject: { ...subject, kind: 'execution', execution: {
      runId: 'run', workflowVersionId: 'version', executionId: 'retry-execution', attempt: 2 } } },
  ]
  const targets: Record<string, unknown>[] = []
  server.use(
    http.get('/api/management/workspaces/workspace/workflows/workflow', () => HttpResponse.json({
      workflow: { ...currentWorkflowFixture().version.definition, id: 'workflow', workspaceId: 'workspace', name: 'Website' }, revision: 1 })),
    http.get('/api/devices/main', () => HttpResponse.json({ mainId: '11111111-1111-4111-8111-111111111111',
      mainPublicKey: 'fixture-key', mainPublicKeyFingerprint: 'a'.repeat(64) })),
    http.get('/api/devices', () => HttpResponse.json({ devices: [] })),
    http.post('/api/management/computers/maintenance/read', async ({ request }) => {
      const { target } = await request.json() as { target: unknown }
      return HttpResponse.json({ computers: [{ target, status: null }] })
    }),
    http.get('/api/browser/profiles', () => HttpResponse.json({ profiles: [], replicas: [], presentReplicas: [], pendingReplicas: [], nextCursor: null, revision: 0 })),
    http.get('/api/browser/sessions', () => HttpResponse.json({ sessions, nextCursor: null, ...(options.runtime ? { runtime: options.runtime } : {}) })),
    http.get('/api/browser/sessions/:id', ({ params }) => HttpResponse.json({ ...browserRead(String(params.id)),
      session: sessions.find(session => session.id === params.id) })),
    http.get('/api/browser/target', ({ request }) => {
      targets.push(JSON.parse(new URL(request.url).searchParams.get('input')!))
      return HttpResponse.json({ kind: 'unavailable', reason: 'node_unavailable' })
    }),
  )
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema.parse,
    component: () => <WorkflowBrowserSidebar workspaceId="workspace" workflowId="workflow" runId="run" workflowVersionId="version" /> })
  const router = createRouter({ routeTree: root.addChildren([route]), history: createMemoryHistory({
    initialEntries: ['/workspaces/workspace?workflowId=workflow&selectedRunId=run&boardBrowsers=1'],
  }) })
  await router.load()
  render(<QueryClientProvider client={newBoardQueryClient()}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByRole('tab', { name: 'Builder' })
  return { targets, router }
}

it('keeps chat and execution browser sessions selectable within the Agent tab', async () => {
  const { targets } = await mountSidebar()
  const picker = await screen.findByRole('combobox', { name: 'Browser context' })
  expect(within(picker).getAllByRole('option')).toHaveLength(3)
  expect(picker).toHaveValue('run-session')
  await waitFor(() => expect(targets.at(-1)).toMatchObject({ runId: 'run', executionId: 'execution' }))
  await userEvent.selectOptions(picker, 'retry-session')
  await waitFor(() => expect(targets.at(-1)).toMatchObject({ runId: 'run', executionId: 'retry-execution' }))
  await userEvent.selectOptions(picker, 'chat-session')
  await waitFor(() => expect(targets.at(-1)).not.toHaveProperty('runId'))
  expect(picker).toHaveValue('chat-session')
}, 15_000)

it('offers closed live browsers for reopening instead of claiming none are active', async () => {
  await mountSidebar()
  await userEvent.click(screen.getByRole('button', { name: 'Close Builder browser' }))
  expect(await screen.findByText(/Active browsers are hidden/)).toBeVisible()
  expect(screen.queryByText('No agent browsers are active in this run.')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Reopen Builder browser' }))
  expect(await screen.findByRole('tab', { name: 'Builder' })).toHaveAttribute('aria-selected', 'true')
}, 15_000)


it('moves the browser window while its Agent tabs stay usable', async () => {
  await mountSidebar()
  const panel = screen.getByRole('complementary', { name: 'Agent browsers' })
  const title = screen.getByRole('heading', { name: 'Agent browsers' })
  const left = panel.style.left, top = panel.style.top
  fireEvent.pointerDown(title, { button: 0, clientX: 30, clientY: 40 })
  fireEvent.pointerMove(window, { clientX: 180, clientY: 160 })
  fireEvent.pointerUp(window)
  expect(panel.style.left).not.toBe(left)
  expect(panel.style.top).not.toBe(top)
  expect(within(panel).getByRole('tab', { name: 'Builder' })).toBeVisible()
})

it('names browser contexts with the workflow, Agent and start time', async () => {
  const startedAt = '2026-10-24T10:30:00.000Z'
  await mountSidebar({ startedAt })
  const picker = screen.getByRole('combobox', { name: 'Browser context' })
  await waitFor(() => expect(within(picker).getByRole('option', { selected: true })).toHaveTextContent(
    `Website · Builder · ${new Date(startedAt).toLocaleString()}`))
  expect(picker).not.toHaveTextContent('run-session')
  expect(picker).not.toHaveTextContent('retry-session')
})

it('explains a reachable computer runtime failure and preserves its real reason in details', async () => {
  const reason = 'Chromium: No usable sandbox! Install the Foreman AppArmor profile runtime/browser/apparmor/foreman-browser-runtime.'
  await mountSidebar({ runtime: { computerId: 'main', ready: false, phase: 'failed', reason } })
  expect(await screen.findByText(/agent browser isn't installed yet: Chromium can't start its sandbox/)).toBeVisible()
  expect(screen.queryByText(/could not be reached/)).not.toBeInTheDocument()
  await userEvent.click(screen.getByText('Browser runtime details', { selector: 'summary' }))
  expect(screen.getByText(reason)).toBeVisible()
})

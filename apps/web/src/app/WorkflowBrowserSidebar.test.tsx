import { QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { BrowserSession } from '@foreman-code/contracts'
import { server } from '../mocks/server'
import { browserRead, subject } from '../features/agent-browser/testFixtures'
import { RunsSelectorSearchSchema } from '../features/runs-selector'
import { useBrowserSidebarTabs } from '../features/workflow-board'
import { installBoardTestLifecycle, newBoardQueryClient } from '../features/workflow-board/eng05D.testSupport'
import { WorkflowBrowserSidebar } from './WorkflowBrowserSidebar'

installBoardTestLifecycle()

async function mountSidebar() {
  useBrowserSidebarTabs.setState({ opened: {}, closed: {} })
  const sessions: BrowserSession[] = [
    { ...browserRead('chat-session').session, subject: { kind: 'conversation', agent: subject.agent, conversationId: 'conversation' } },
    browserRead('run-session').session,
    { ...browserRead('retry-session').session, subject: { ...subject, kind: 'execution', execution: {
      runId: 'run', workflowVersionId: 'version', executionId: 'retry-execution', attempt: 2 } } },
  ]
  const targets: Record<string, unknown>[] = []
  server.use(
    http.get('/api/devices/main', () => HttpResponse.json({ mainId: '11111111-1111-4111-8111-111111111111',
      mainPublicKey: 'fixture-key', mainPublicKeyFingerprint: 'a'.repeat(64) })),
    http.get('/api/devices', () => HttpResponse.json({ devices: [] })),
    http.post('/api/management/computers/maintenance/read', async ({ request }) => {
      const { target } = await request.json() as { target: unknown }
      return HttpResponse.json({ computers: [{ target, status: null }] })
    }),
    http.get('/api/browser/profiles', () => HttpResponse.json({ profiles: [], replicas: [], presentReplicas: [], pendingReplicas: [], nextCursor: null, revision: 0 })),
    http.get('/api/browser/sessions', () => HttpResponse.json({ sessions, nextCursor: null })),
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
})

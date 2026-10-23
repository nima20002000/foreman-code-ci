// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider } from '@tanstack/react-router'
import { act, cleanup, configure, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { LocalHumanAccessSchema } from '@foreman-code/contracts/management'
import { CURRENT_WORKFLOW_CAPABILITIES, CurrentWorkflowCapabilitiesSchema } from '@foreman-code/contracts/wave25'
import { server } from '../../mocks/server'
import { deferred } from '../../test/deferred'
import { workflowToGraph } from '../graph/mapper'
import { installFlowLayout } from '../run-board/testFlowLayout'
import { pinnedRunHandlers, reply, runsUrl, scope, versionReply } from '../run-board/testFixtures'
import { RunsSelectorSearchSchema } from '../runs-selector/search'
import { WorkflowBoard } from './WorkflowBoard'
import { useSidePanelPresentation } from './sidePanelPresentation'
import { clearBoardStopStorage } from './stopOutbox'

configure({ asyncUtilTimeout: 5000 })
const clients: QueryClient[] = []
const snapshotPath = '*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/snapshot'
const versionPath = '*/api/management/workspaces/:workspaceId/runs/:runId/version'

/** The saved version places Y by hand (manual) at its own size; X and Z keep the automatic layout. */
function savedVersion(runId: string) {
  const detail = versionReply(reply(runId).snapshot)
  const nodes = detail.version.definition.nodes.map(node => node.id === 'node-y'
    ? { ...node, position: { x: 640, y: -90, manual: true }, width: 300, height: 300 } : node)
  return { ...detail, version: { ...detail.version, definition: { ...detail.version.definition, nodes } } }
}

beforeEach(() => {
  installFlowLayout(900, 600)
  vi.stubGlobal('EventSource', class extends EventTarget { close() { /* ignore: no stream under test */ } })
  useSidePanelPresentation.setState({ scroll: {} })
  clearBoardStopStorage()
  localStorage.clear()
  const commands = new Map<string, Promise<unknown>>()
  Object.defineProperty(navigator, 'locks', { configurable: true, value: { request: (key: string, work: () => unknown) => {
    const next = (commands.get(key) ?? Promise.resolve()).then(work)
    commands.set(key, next.catch(() => { /* ignore: callers receive failure; later commands still need the lock. */ }))
    return next
  } } })
  server.use(...pinnedRunHandlers(scope),
    http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/runs/summaries', () =>
      HttpResponse.json({ items: [], pageInfo: { nextCursor: null } })),
    http.get(snapshotPath, ({ params }) => HttpResponse.json(reply(String(params.runId)))),
    http.get(versionPath, ({ params }) => HttpResponse.json(savedVersion(String(params.runId)))),
    http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/hierarchy', ({ request }) =>
      HttpResponse.json({ ...scope, workflowVersionId: 'version-a', revision: 1, hierarchy: null, agents: [],
        run: { runId: new URL(request.url).searchParams.get('runId'), state: 'running' } })),
    http.get('*/api/management/workspaces/:workspaceId/ci', ({ request }) =>
      HttpResponse.json({ runId: new URL(request.url).searchParams.get('runId'), jobs: [], truncated: false })),
    http.get('*/api/management/workspaces/:workspaceId/runs/:runId/subagents', () =>
      HttpResponse.json({ items: [], nextCursor: null, projection: 'caught-up' })),
  )
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()); vi.restoreAllMocks(); vi.unstubAllGlobals() })

async function mount(entry: string) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(cache)
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId', validateSearch: RunsSelectorSearchSchema,
    component: () => <WorkflowBoard {...scope} inspection={{}} selectInspection={() => undefined}
      selectRun={() => undefined} summaries={[]}>
      <p>Draft editor</p>
    </WorkflowBoard> })
  const router = createRouter({ routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [entry] }), defaultPendingMinMs: 0 })
  await router.load()
  render(<QueryClientProvider client={cache}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByTestId('unified-workflow-board')
  return { router }
}
const savedNode = (name: string) => screen.findByRole('group', { name: `${name}, saved agent, read only` })
const viewport = () => document.querySelector<HTMLElement>('[data-testid="run-board-canvas"] .react-flow__viewport')!

describe('a selected Run is drawn as the same Board as the draft', () => {
  it('keeps every saved place and size, including manual ones, exactly where the draft Board draws them', async () => {
    await mount(runsUrl('run-a'))
    const draft = workflowToGraph({ workflow: savedVersion('run-a').version.definition, agents: [] }).nodes
    const expected = new Map(draft.map(node => [node.id, node]))
    for (const [id, name] of [['node-x', 'X before rename'], ['node-y', 'Y'], ['node-z', 'Z']] as const) {
      const node = await savedNode(name), shown = expected.get(id)!
      expect(node).toHaveStyle({ transform: `translate(${shown.position.x}px,${shown.position.y}px)`,
        width: `${shown.width}px`, height: `${shown.height}px` })
    }
    expect(await savedNode('Y')).toHaveStyle({ transform: 'translate(640px,-90px)', width: '300px', height: '300px' })
  })

  it('draws an approval beside a handoff on the handoff’s one line, as the draft Board does', async () => {
    await mount(runsUrl('run-a'))
    await savedNode('Z')
    await waitFor(() => expect(document.querySelectorAll('[data-testid="run-board-canvas"] .react-flow__edge')).toHaveLength(2))
    const line = document.querySelector('[data-testid="run-board-canvas"] .react-flow__edge[data-id="edge-xy"]')!
    expect(line.getAttribute('aria-label')).toMatch(/^Handoff · approval from X before rename to Y/)
  })

  it('zooms with the mouse wheel during a Run', async () => {
    await mount(runsUrl('run-a'))
    await savedNode('Z')
    await waitFor(() => expect(viewport().style.transform).toMatch(/scale/))
    const before = viewport().style.transform
    const pane = document.querySelector('[data-testid="run-board-canvas"] .react-flow__pane')!
    await act(async () => {
      pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: 300, clientY: 300, bubbles: true, cancelable: true }))
      await new Promise(resolve => setTimeout(resolve, 50))
    })
    await waitFor(() => expect(viewport().style.transform).not.toBe(before))
  })

  it('keeps the draft Board on screen until the started Run can be drawn, then shows it with no loading screen', async () => {
    const gate = deferred<void>()
    server.use(http.get(snapshotPath, async ({ params }) => { await gate.promise; return HttpResponse.json(reply(String(params.runId))) }))
    const { router } = await mount(runsUrl(null))
    expect(screen.getByText('Draft editor')).toBeVisible()
    await act(async () => { await router.navigate({ href: runsUrl('run-a') }) })
    expect(screen.getByText('Draft editor')).toBeVisible()
    // No empty or loading Run board replaces the draft while the Run is read.
    expect(screen.queryByRole('region', { name: 'Selected Run board' })).not.toBeInTheDocument()
    await act(async () => { gate.resolve() })
    await savedNode('Z')
    expect(screen.getByText('Draft editor')).not.toBeVisible()
  })

  it('returns to the same view the person zoomed to when the Run is shown again', async () => {
    const { router } = await mount(runsUrl('run-a'))
    await savedNode('Z')
    await waitFor(() => expect(viewport().style.transform).toMatch(/scale/))
    const fitted = viewport().style.transform
    const pane = document.querySelector('[data-testid="run-board-canvas"] .react-flow__pane')!
    await act(async () => {
      pane.dispatchEvent(new WheelEvent('wheel', { deltaY: -400, clientX: 300, clientY: 300, bubbles: true, cancelable: true }))
      await new Promise(resolve => setTimeout(resolve, 400))
    })
    const zoomed = viewport().style.transform
    expect(zoomed).not.toBe(fitted)
    await act(async () => { await router.navigate({ href: runsUrl(null) }) })
    await act(async () => { await router.navigate({ href: runsUrl('run-a') }) })
    await savedNode('Z')
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 200)) })
    expect(viewport().style.transform).toBe(zoomed)
  })
})

describe('the running Run has one plain Stop button', () => {
  it('stops the Run with one click, without a menu or a confirmation', async () => {
    const stops: unknown[] = []
    const run = { ...scope, runId: 'run-b', workflowVersionId: 'version-b', executionSemanticsVersion: 3,
      executionState: 'running', outcome: 'pending', createdAt: '2026-10-01T00:00:00Z', cleanupPending: false }
    const sent = deferred<void>()
    server.use(
      http.get('*/api/local-human', () => HttpResponse.json(LocalHumanAccessSchema.parse({ principal: {
        id: 'operator-test', name: 'Test Operator', expiresAt: '2099-01-01T00:00:00Z',
        grants: [{ actions: ['runs:read', 'runs:stop'], scope: { workspaceIds: [scope.workspaceId] } }],
      } }))),
      http.get('*/api/management/workflows/capabilities/v3', () => HttpResponse.json(CurrentWorkflowCapabilitiesSchema.parse({
        ...CURRENT_WORKFLOW_CAPABILITIES, runtimeAdmission: true, meaningfulEdit: true, stopAvailable: true, reasons: [],
        editIntents: { ...CURRENT_WORKFLOW_CAPABILITIES.editIntents, stopUnsettled: true },
      }))),
      http.get('*/api/management/workspaces/:workspaceId/runs/run-b/executions', () =>
        HttpResponse.json({ run, items: [], pageInfo: { nextCursor: null } })),
      http.post('*/api/management/workspaces/:workspaceId/runs/run-b/stop', async ({ request }) => {
        stops.push(await request.json())
        await sent.promise
        return HttpResponse.json({ runId: 'run-b', status: 'accepted', processStopped: false, replayed: false })
      }),
    )
    await mount(runsUrl('run-b'))
    const toolbar = within(screen.getByRole('banner', { name: 'Board toolbar' }))
    expect(toolbar.queryByRole('button', { name: /Run controls/ })).not.toBeInTheDocument()
    await waitFor(() => expect(toolbar.getByRole('button', { name: 'Stop' })).toBeEnabled())
    fireEvent.click(toolbar.getByRole('button', { name: 'Stop' }))
    await waitFor(() => expect(stops).toHaveLength(1))
    expect(stops[0]).toMatchObject({ workspaceId: scope.workspaceId, runId: 'run-b' })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    expect(toolbar.getByRole('button', { name: 'Stopping…' })).toBeDisabled()
    await act(async () => { sent.resolve() })
    await waitFor(() => expect(toolbar.getByRole('button', { name: 'Stopping…' })).toBeDisabled())
    expect(stops).toHaveLength(1)
  })
})

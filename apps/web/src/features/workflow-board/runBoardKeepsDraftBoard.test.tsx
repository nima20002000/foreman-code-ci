// @vitest-environment jsdom
import { useLayoutEffect, type ReactNode } from 'react'
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
import { pinnedRunHandlers, reply, runA, runsUrl, scope, versionReply } from '../run-board/testFixtures'
import { RunsSelectorSearchSchema } from '../runs-selector/search'
import { WorkflowBoard } from './WorkflowBoard'
import { useWorkflowBoard } from './context'
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

async function mount(entry: string, draft: ReactNode = <p>Draft editor</p>) {
  const cache = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(cache)
  const root = createRootRoute({ component: Outlet })
  const route = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId', validateSearch: RunsSelectorSearchSchema,
    component: () => <WorkflowBoard {...scope} inspection={{}} selectInspection={() => undefined}
      selectRun={() => undefined} summaries={[]}>
      {draft}
    </WorkflowBoard> })
  const router = createRouter({ routeTree: root.addChildren([route]),
    history: createMemoryHistory({ initialEntries: [entry] }), defaultPendingMinMs: 0 })
  await router.load()
  render(<QueryClientProvider client={cache}><RouterProvider router={router} /></QueryClientProvider>)
  await screen.findByTestId('unified-workflow-board')
  return { router }
}
const savedNode = (name: string) => screen.findByRole('group', { name: `${name}, saved agent, read only` })
/** A real mouse gesture; d3-drag follows the pointer on `event.view`, which jsdom's constructor will not set. */
function pointer(target: EventTarget, type: string, clientX: number, clientY: number) {
  const event = new MouseEvent(type, { clientX, clientY, button: 0, buttons: type === 'mouseup' ? 0 : 1, bubbles: true, cancelable: true })
  Object.defineProperty(event, 'view', { value: window })
  target.dispatchEvent(event)
}
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
    // Accepted, yet the Run still runs: the same button resends the same retained stop, still without a dialog.
    await waitFor(() => expect(toolbar.getByRole('button', { name: 'Stop again' })).toBeEnabled())
    expect(toolbar.getByText('Stopping…')).toBeVisible()
    fireEvent.click(toolbar.getByRole('button', { name: 'Stop again' }))
    await waitFor(() => expect(stops).toHaveLength(2))
    expect(stops[1]).toEqual(stops[0])
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
})

describe('the Run board never strands the person', () => {
  it('shows the Run board with its own loading state when the Run read hangs, instead of an inert draft', async () => {
    server.use(http.get(snapshotPath, () => new Promise<never>(() => { /* ignore: the read never answers */ })))
    const { router } = await mount(runsUrl(null))
    await act(async () => { await router.navigate({ href: runsUrl('run-a') }) })
    const board = await screen.findByRole('region', { name: 'Selected Run board' }, { timeout: 3000 })
    expect(board).toHaveTextContent('Loading…')
    expect(screen.getByText('Draft editor')).not.toBeVisible()
    expect(screen.getByRole('banner', { name: 'Board toolbar' })).toBeVisible()
  })
})

describe('the Run board shows what it folds onto one line and keeps its caption out of the toolbar\'s way', () => {
  it('names a folded approval\'s own label and direction on the shared line', async () => {
    const snapshot = { ...runA, edges: [
      { id: 'edge-xy', source: 'node-x', target: 'node-y', kind: 'execution' as const },
      { id: 'approval-yx', source: 'node-y', target: 'node-x', kind: 'approval' as const, label: 'Design sign-off' },
      runA.edges[2]!,
    ] }
    server.use(
      http.get(snapshotPath, () => HttpResponse.json({ snapshot })),
      http.get(versionPath, () => HttpResponse.json(versionReply(snapshot))),
    )
    await mount(runsUrl('run-a'))
    await savedNode('Z')
    await waitFor(() => expect(document.querySelector('[data-testid="run-board-canvas"] .react-flow__edge[data-id="edge-xy"]')).toBeInTheDocument())
    const line = document.querySelector('[data-testid="run-board-canvas"] .react-flow__edge[data-id="edge-xy"]')!
    expect(line.getAttribute('aria-label')).toContain('approval from Y to X before rename: Design sign-off')
  })

  it('puts the Run\'s worktree caption inside the floating toolbar, so neither covers the other', async () => {
    await mount(runsUrl('run-a'))
    await savedNode('Z')
    const toolbar = within(screen.getByRole('banner', { name: 'Board toolbar' }))
    expect(toolbar.getByText('Read only')).toBeVisible()
    expect(toolbar.getByText(/Worktree/)).toBeVisible()
  })
})

describe('the Run view follows the draft Board\'s rules', () => {
  it('moves a dragged agent through the draft Board\'s own layout change and keeps it where it was dropped', async () => {
    const moves: { id: string; position?: { x: number; y: number } }[][] = []
    function DraftProbe() {
      const board = useWorkflowBoard()
      const register = board?.registerAuthoringActions
      useLayoutEffect(() => {
        register?.({ openWorkflowSettings: () => undefined, draftNodeAgentId: () => undefined, draftNodeBrowser: () => undefined,
          saveChatAgent: async () => undefined, moveNodes: changes => { moves.push(changes) } })
        return () => register?.()
      }, [register])
      return <p>Draft editor</p>
    }
    await mount(runsUrl('run-a'), <DraftProbe />)
    const z = await savedNode('Z')
    await waitFor(() => expect(viewport().style.transform).toMatch(/scale/))
    const before = z.style.transform
    const node = z.closest<HTMLElement>('.react-flow__node') ?? z
    await act(async () => {
      pointer(node, 'mousedown', 100, 100)
      pointer(window, 'mousemove', 160, 140)
      pointer(window, 'mousemove', 220, 180)
      pointer(window, 'mouseup', 220, 180)
    })
    await waitFor(() => expect(moves).toHaveLength(1))
    expect(moves[0]).toEqual([expect.objectContaining({ id: 'node-z', position: expect.any(Object) })])
    expect(z.style.transform).not.toBe(before)
  })
})

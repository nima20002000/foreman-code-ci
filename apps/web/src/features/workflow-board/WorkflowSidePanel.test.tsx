// @vitest-environment jsdom
import { useEffect, useState, type ReactNode } from 'react'
import { createPortal } from 'react-dom'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useMatch } from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineChatReadbackSchema, collaborationContractFixtures } from '@foreman-code/contracts'
import { Button, Dialog, Textarea } from '../../shared/ui/nocturne'
import { resolveRunsSelectorBoardLocation, RunsSelectorSearchSchema, useSelectedRun } from '../runs-selector'
import { useWorkflowSidePanel } from './useWorkflowSidePanel'
import { WorkflowSidePanel, type WorkflowCollaborationSlots as PanelSlots } from './WorkflowSidePanel'

type WorkflowCollaborationSlots = PanelSlots & { memoryBoard?(): ReactNode }
import { queryKeys } from '../../shared/api/query'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

/** A public consumer of the shell slots. Its local draft owner outlives selected bodies. */
type Navigation = Pick<ReturnType<typeof useWorkflowSidePanel>, 'selectPanel' | 'selectView' | 'setMemoryOpen'>

function ShellFixture({ slots, captureNavigation }: { slots?: WorkflowCollaborationSlots
  captureNavigation?: (navigation: Navigation) => void }) {
  // The departing Board still owns its matched route until the next page mounts.
  const match = useMatch({ strict: false })
  const resolved = resolveRunsSelectorBoardLocation(match.pathname, match.search)
  const side = useWorkflowSidePanel(resolved.workspaceId, resolved.workflowId ?? 'workflow', resolved.run,
    slots?.beforeBrowserHide)
  const selectedRun = useSelectedRun({ workspaceId: 'workspace', workflowId: 'workflow' })
  useEffect(() => {
    captureNavigation?.({ selectPanel: side.selectPanel, selectView: side.selectView, setMemoryOpen: side.setMemoryOpen })
  }, [captureNavigation, side.selectPanel, side.selectView, side.setMemoryOpen])
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState('')
  const [actionAvailable, setActionAvailable] = useState(true)
  const readback = EngineChatReadbackSchema.parse(collaborationContractFixtures.executionReadback)
  return <>
    <nav aria-label="Board controls">
      <Button onClick={() => side.selectPanel({ kind: 'agent', nodeId: 'node-a', tab: 'settings' })}>Open Agent settings</Button>
      <Button onClick={() => { if (side.agentSelection) side.selectPanel(side.agentSelection) }}>Open selected Agent</Button>
      <Button onClick={() => side.selectPanel({ kind: 'browser' })}>Open Browser</Button>
      <Button onClick={() => side.setMemoryOpen(true)}>Memory board</Button>
      <Button onClick={() => side.selectView('overview')}>Overview</Button>
      <Button onClick={() => side.selectView('graph')}>Graph</Button>
      <Button onClick={() => void selectedRun.selectRun('run-b')}>Select Run B</Button>
      <Button onClick={() => void selectedRun.selectRun(null)}>Return to draft</Button>
    </nav>
    <main aria-label="Board canvas">{side.view === 'overview' ? 'Overview is not available yet.' : 'Editing surface'}
      <p>{readback.messages[0]!.content}</p>
    </main>
    <WorkflowSidePanel scope={side.scope} workspaceId="workspace" workflowId="workflow" opener={side.opener} runId={resolved.run?.runId}
      workflowVersionId={resolved.run?.workflowVersionId} slots={slots}
      selection={side.panel} agentSelection={side.agentSelection} onSelect={side.selectPanel}
      onSelectTarget={side.selectChatTarget} onSelectRun={side.selectChatRun}
      bodyRef={setHost} modalOpen={side.memoryOpen} />
    {host && side.panel.kind === 'agent' && !side.panel.executionId && !side.memoryOpen
      && (!slots?.executionChat || side.panel.tab !== 'chat')
      ? createPortal(<div role="region" aria-label="Fixture transcript" className="fixture-scroll">
        <Textarea autoFocus label="Agent settings draft" value={draft}
          onChange={event => setDraft(event.target.value)} />
        {actionAvailable ? <Button onClick={() => setActionAvailable(false)}>Finish panel action</Button> : null}
        <Button onKeyDown={event => { if (event.key === 'Escape') event.preventDefault() }}>Nested control</Button>
      </div>, host) : null}
    <Dialog open={side.memoryOpen} onOpenChange={side.setMemoryOpen} title="Memory board" closeLabel="Close Memory board">
      {side.memoryOpen ? slots?.memoryBoard?.() : null}
    </Dialog>
  </>
}

function mount(entry: string, extra?: WorkflowCollaborationSlots | ((navigation: Navigation) => void)) {
  const slots = typeof extra === 'function' ? undefined : extra
  const captureNavigation = typeof extra === 'function' ? extra : undefined
  const root = createRootRoute({ component: Outlet })
  const component = () => <ShellFixture slots={slots} captureNavigation={captureNavigation} />
  const board = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema.parse, component })
  const pinned = createRoute({ getParentRoute: () => root,
    path: '/workspaces/$workspaceId/workflows/$workflowId/runs/$runId/graph/$workflowVersionId/3',
    validateSearch: RunsSelectorSearchSchema.parse, component })
  const settings = createRoute({ getParentRoute: () => root, path: '/settings', component: () => <p>Outside Board</p> })
  const router = createRouter({ routeTree: root.addChildren([board, pinned, settings]),
    history: createMemoryHistory({ initialEntries: [entry] }) })
  // The panel names its Agent from the already loaded workflow; that read is seeded so the shell itself does no fetching.
  const queries = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } })
  queries.setQueryData(queryKeys.managedWorkflow('workspace', 'workflow'), { workflow: { nodes: [{ id: 'node-a', name: 'Alpha' }] } })
  render(<QueryClientProvider client={queries}><RouterProvider router={router} /></QueryClientProvider>)
  return router
}

describe('disabled collaboration shell through navigation and rendered controls', () => {
  it.each(['panel', 'view', 'memory'] as const)('ignores a delayed %s action after leaving its Board', async kind => {
    let pending: Navigation | undefined
    const router = mount('/workspaces/workspace?workflowId=workflow&runId=run-a&workflowVersionId=version-a&executionSemanticsVersion=3',
      navigation => { pending ??= navigation })
    await screen.findByRole('button', { name: 'Open Agent settings' })
    expect(pending).toBeDefined()
    await act(async () => { await router.navigate({ to: '/settings' }) })
    expect(await screen.findByText('Outside Board')).toBeVisible()
    await act(async () => {
      if (kind === 'panel') pending!.selectPanel({ kind: 'browser' })
      if (kind === 'view') pending!.selectView('overview')
      if (kind === 'memory') pending!.setMemoryOpen(true)
    })
    await waitFor(() => expect(router.state.status).toBe('idle'))
    expect(router.state.location.pathname).toBe('/settings')
    expect(screen.getByText('Outside Board')).toBeVisible()
  })

  it('does not move another workspace back to the owner of a stale panel action', async () => {
    let pending: Navigation | undefined
    const router = mount('/workspaces/workspace?workflowId=workflow', navigation => { pending ??= navigation })
    await screen.findByRole('button', { name: 'Open Agent settings' })
    expect(pending).toBeDefined()
    await act(async () => { await router.navigate({ to: '/workspaces/$workspaceId',
      params: { workspaceId: 'other-workspace' }, search: { workflowId: 'other-workflow' } }) })
    await act(async () => pending!.selectPanel({ kind: 'browser' }))
    await waitFor(() => expect(router.state.status).toBe('idle'))
    expect(router.state.location.pathname).toBe('/workspaces/other-workspace')
    expect(router.state.location.search).toEqual({ workflowId: 'other-workflow' })
  })

  it('closes after a focused portal control disappears, deferring Escape while a dialog is open', async () => {
    const user = userEvent.setup()
    const router = mount('/workspaces/workspace?workflowId=workflow')
    const opener = await screen.findByRole('button', { name: 'Open Agent settings' })
    await user.click(opener)
    const panel = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    const action = within(panel).getByRole('button', { name: 'Finish panel action' })
    await user.click(action)
    expect(action).not.toBeInTheDocument()
    expect(document.body).toHaveFocus()
    const modal = render(<dialog open aria-label="Other dialog">Another surface owns Escape</dialog>)
    await user.keyboard('{Escape}')
    expect(panel).toBeVisible()
    modal.unmount()
    await user.keyboard('{Escape}')
    await waitFor(() => expect(panel).not.toBeVisible())
    expect(router.state.location.search).not.toHaveProperty('boardPanel')
    expect(opener).toHaveFocus()
  })

  it('leaves the rail open when a nested control consumes Escape or focus moves outside', async () => {
    const user = userEvent.setup()
    mount('/workspaces/workspace?workflowId=workflow')
    const opener = await screen.findByRole('button', { name: 'Open Agent settings' })
    await user.click(opener)
    const panel = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    await user.click(within(panel).getByRole('button', { name: 'Nested control' }))
    await user.keyboard('{Escape}')
    expect(panel).toBeVisible()
    await act(async () => opener.focus())
    await user.keyboard('{Escape}')
    expect(panel).toBeVisible()
    await act(async () => opener.blur())
    expect(document.body).toHaveFocus()
    await user.keyboard('{Escape}')
    expect(panel).toBeVisible()
  })

  it('keeps local drafts, retained selection and width across destination, modal and history changes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const router = mount('/workspaces/workspace?workflowId=workflow')
    const user = userEvent.setup()
    const opener = await screen.findByRole('button', { name: 'Open Agent settings' })
    await user.click(opener)
    await user.type(await screen.findByRole('textbox', { name: 'Agent settings draft' }), 'Keep this unsaved edit')
    const rail = within(screen.getByRole('complementary', { name: 'Workflow side panel' }))
    fireEvent.scroll(screen.getByRole('region', { name: 'Fixture transcript' }), { target: { scrollTop: 125 } })
    await user.click(screen.getByRole('button', { name: 'Open Browser' }))
    expect(await screen.findByText('Browser is not available yet. No browser session has been started.')).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Agent settings draft' })).not.toBeInTheDocument()
    expect(router.state.location.search).toMatchObject({ boardPanel: 'browser', boardNodeId: 'node-a', boardAgentTab: 'settings' })
    await act(async () => { router.history.back() })
    expect(await screen.findByRole('textbox', { name: 'Agent settings draft' })).toHaveValue('Keep this unsaved edit')
    expect(screen.getByRole('region', { name: 'Fixture transcript' }).scrollTop).toBe(125)
    await act(async () => { router.history.forward() })
    await screen.findByText('Browser is not available yet. No browser session has been started.')
    await user.click(screen.getByRole('button', { name: 'Open selected Agent' }))
    expect(await screen.findByRole('textbox', { name: 'Agent settings draft' })).toHaveValue('Keep this unsaved edit')
    await user.click(screen.getByRole('button', { name: /^Memory board$/ }))
    expect(await screen.findByRole('dialog', { name: 'Memory board' })).toBeVisible()
    expect(screen.queryByRole('complementary', { name: 'Workflow side panel' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Close Memory board' }))
    expect(await screen.findByRole('textbox', { name: 'Agent settings draft' })).toHaveValue('Keep this unsaved edit')
    await user.click(rail.getByRole('button', { name: 'Back to Board' }))
    await waitFor(() => expect(opener).toHaveFocus())
    expect(fetch).not.toHaveBeenCalled()
  })

  it('carries path-owned immutable Run pins through every shell navigation', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch'), user = userEvent.setup()
    const router = mount('/workspaces/workspace/workflows/workflow/runs/run-a/graph/version-a/3?boardPanel=agent&boardNodeId=node-a&boardExecutionId=execution-a')
    await screen.findByText(/Chat for this selected execution is not available yet/)
    await user.click(screen.getByRole('button', { name: 'Open Browser' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ workflowId: 'workflow',
      runId: 'run-a', workflowVersionId: 'version-a', executionSemanticsVersion: 3,
      boardPanel: 'browser', boardNodeId: 'node-a', boardExecutionId: 'execution-a' }))
    expect(await screen.findByText(/No browser session has been started/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: /^Overview$/ }))
    await user.click(screen.getByRole('button', { name: /^Memory board$/ }))
    await screen.findByRole('dialog', { name: 'Memory board' })
    expect(router.state.location.search).toMatchObject({ runId: 'run-a', workflowVersionId: 'version-a',
      boardView: 'overview', boardPanel: 'browser', boardExecutionId: 'execution-a', boardMemory: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('mounts only the selected injected body and retains the exact held execution across modal and destination changes', async () => {
    const selected = vi.fn(), events: string[] = []
    function Body({ name }: { name: string }) {
      useEffect(() => { events.push(`open ${name}`); return () => { events.push(`close ${name}`) } }, [name])
      return <p>{name} body</p>
    }
    const path = '/workspaces/workspace/workflows/workflow/runs/run-a/graph/version-a/3'
    const router = mount(`${path}?boardPanel=agent&boardNodeId=master-node&boardExecutionId=held-execution`, {
      executionChat: value => { selected(value); return <Body name="Execution" /> },
      browser: () => <Body name="Browser" />, memoryBoard: () => <Body name="Memory" />,
    })
    await screen.findByText('Execution body')
    expect(selected).toHaveBeenLastCalledWith(expect.objectContaining({ workspaceId: 'workspace', workflowId: 'workflow', runId: 'run-a',
      workflowVersionId: 'version-a', nodeId: 'master-node', executionId: 'held-execution' }))
    expect(events).toEqual(['open Execution'])
    await userEvent.click(screen.getByRole('button', { name: 'Memory board' }))
    await screen.findByText('Memory body')
    expect(router.state.location.pathname).toBe(path)
    expect(screen.queryByText('Execution body')).not.toBeInTheDocument()
    expect(events).toEqual(['open Execution', 'close Execution', 'open Memory'])
    await userEvent.click(screen.getByRole('button', { name: 'Close Memory board' }))
    await screen.findByText('Execution body')
    expect(events.slice(-2)).toEqual(['close Memory', 'open Execution'])
    await userEvent.click(screen.getByRole('button', { name: 'Open Browser' }))
    await screen.findByText('Browser body')
    expect(screen.queryByText('Execution body')).not.toBeInTheDocument()
    expect(events.slice(-2)).toEqual(['close Execution', 'open Browser'])
    await userEvent.click(screen.getByRole('button', { name: 'Open selected Agent' }))
    await screen.findByText('Execution body')
    expect(selected).toHaveBeenLastCalledWith(expect.objectContaining({ runId: 'run-a', workflowVersionId: 'version-a', executionId: 'held-execution' }))
  })

  it('requests owned browser release before hiding and keeps navigation available while that release is pending', async () => {
    const events: string[] = [], browser = vi.fn()
    function BrowserBody() {
      useEffect(() => { events.push('visible'); return () => { events.push('hidden') } }, [])
      return <p>Owned browser view</p>
    }
    const release = vi.fn(() => { events.push('release requested'); return new Promise<void>(() => undefined) })
    const router = mount('/workspaces/workspace/workflows/workflow/runs/run-a/graph/version-a/3?boardPanel=browser&boardNodeId=worker-node&boardExecutionId=execution-a', {
      browser: selection => { browser(selection); return <BrowserBody /> }, beforeBrowserHide: release,
    })
    await screen.findByText('Owned browser view')
    expect(browser).toHaveBeenLastCalledWith({ kind: 'browser', workspaceId: 'workspace', workflowId: 'workflow',
      runId: 'run-a', workflowVersionId: 'version-a', nodeId: 'worker-node', executionId: 'execution-a' })
    await userEvent.click(screen.getByRole('button', { name: 'Open Agent settings' }))
    await screen.findByRole('textbox', { name: 'Agent settings draft' })
    expect(events).toEqual(['visible', 'release requested', 'hidden'])
    expect(release).toHaveBeenCalledOnce()
    await userEvent.click(screen.getByRole('button', { name: 'Open Browser' }))
    await screen.findByText('Owned browser view')
    await userEvent.click(screen.getByRole('button', { name: 'Memory board' }))
    await screen.findByRole('dialog', { name: 'Memory board' })
    expect(events.slice(-3)).toEqual(['visible', 'release requested', 'hidden'])
    expect(release).toHaveBeenCalledTimes(2)
    expect(router.state.location.search).toMatchObject({ runId: 'run-a', workflowVersionId: 'version-a', boardMemory: true })
  })

  it('commits exact consultation and execution targets to URL history, retaining consultation pins until an explicit new Run choice', async () => {
    const selected = vi.fn(), agent = { workspaceId: 'workspace', workflowId: 'workflow', workflowNodeId: 'master-node', agentId: 'agent-master' }
    const router = mount('/workspaces/workspace?workflowId=workflow&runId=run-a&workflowVersionId=version-a&executionSemanticsVersion=3&boardPanel=agent&boardNodeId=master-node', {
      executionChat: value => {
        selected(value)
        return <section aria-label="Exact chat navigation">
          <p>{value.waitingActivationId ?? value.executionId ?? 'Choose exact work'}</p>
          <Button onClick={() => value.onSelectTarget({ kind: 'workflow_coordinator', agent,
            runId: 'run-a', waitingActivationId: 'waiting-a' }, 'version-a')}>Select waiting coordinator</Button>
          <Button onClick={() => value.onSelectTarget({ kind: 'workflow_execution', agent, execution: {
            runId: 'run-a', workflowVersionId: 'version-a', executionId: 'held-a', activationId: 'activation-a', attempt: 1,
          } }, 'version-a')}>Select held execution</Button>
          <Button onClick={() => value.onSelectRun({ runId: 'run-b', workflowVersionId: 'version-b' })}>Choose another Run</Button>
        </section>
      },
    })
    await userEvent.click(await screen.findByRole('button', { name: 'Select waiting coordinator' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ runId: 'run-a', workflowVersionId: 'version-a',
      boardNodeId: 'master-node', boardWaitingActivationId: 'waiting-a', boardAgentTab: 'chat' }))
    expect(router.state.location.search).not.toHaveProperty('boardExecutionId')
    await userEvent.click(screen.getByRole('button', { name: 'Open Browser' }))
    await userEvent.click(screen.getByRole('button', { name: 'Memory board' }))
    await screen.findByRole('dialog', { name: 'Memory board' })
    expect(router.state.location.search).toMatchObject({ boardWaitingActivationId: 'waiting-a' })
    await userEvent.click(screen.getByRole('button', { name: 'Close Memory board' }))
    await userEvent.click(screen.getByRole('button', { name: 'Open selected Agent' }))
    expect(await screen.findByText('waiting-a')).toBeVisible()
    expect(selected).toHaveBeenLastCalledWith(expect.objectContaining({ waitingActivationId: 'waiting-a', runId: 'run-a', workflowVersionId: 'version-a' }))
    await userEvent.click(screen.getByRole('button', { name: 'Select held execution' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ boardExecutionId: 'held-a' }))
    expect(router.state.location.search).not.toHaveProperty('boardWaitingActivationId')
    await act(async () => { router.history.back() })
    expect(await screen.findByText('waiting-a')).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Choose another Run' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ runId: 'run-b', workflowVersionId: 'version-b', boardNodeId: 'master-node' }))
    expect(router.state.location.search).not.toHaveProperty('boardExecutionId')
    expect(router.state.location.search).not.toHaveProperty('boardWaitingActivationId')
    expect(await screen.findByText('Choose exact work')).toBeVisible()
  })

  it('offers Chat, Settings, Details and Browser in the Agent panel', async () => {
    const user = userEvent.setup()
    const router = mount('/workspaces/workspace?workflowId=workflow')
    await user.click(await screen.findByRole('button', { name: 'Open Agent settings' }))
    const rail = within(screen.getByRole('complementary', { name: 'Workflow side panel' }))
    expect(rail.getByRole('heading', { name: 'Alpha' })).toBeVisible()
    const views = within(rail.getByRole('navigation', { name: 'Workflow panel view' }))
    expect(views.getAllByRole('button').map(button => button.getAttribute('aria-label') ?? button.textContent))
      .toEqual(['Chat', 'Settings', 'Details', 'Browser'])
    expect(rail.queryByRole('button', { name: 'Operator' })).not.toBeInTheDocument()
    await user.click(rail.getByRole('button', { name: 'Back to Board' }))
    expect(router.state.location.search).not.toHaveProperty('boardPanel')
  })

  it('keeps a query-selected Run responsive across panel changes and browser history', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const user = userEvent.setup()
    const router = mount('/workspaces/workspace?workflowId=workflow&runId=run-a&workflowVersionId=version-a&executionSemanticsVersion=3')
    await user.click(await screen.findByRole('button', { name: 'Open Browser' }))
    expect(await screen.findByText('Browser is not available yet. No browser session has been started.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: /^Overview$/ }))
    expect(screen.getByRole('main', { name: 'Board canvas' })).toHaveTextContent('Overview is not available yet.')
    await act(async () => { router.history.back() })
    await waitFor(() => expect(screen.getByRole('main', { name: 'Board canvas' })).toHaveTextContent('Editing surface'))
    expect(router.state.location.search).toMatchObject({ workflowId: 'workflow', runId: 'run-a',
      workflowVersionId: 'version-a', executionSemanticsVersion: 3, boardPanel: 'browser' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

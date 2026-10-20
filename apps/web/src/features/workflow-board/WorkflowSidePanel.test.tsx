// @vitest-environment jsdom
import { useState } from 'react'
import { createPortal } from 'react-dom'
import { act, cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { createMemoryHistory, createRootRoute, createRoute, createRouter, Outlet, RouterProvider, useLocation } from '@tanstack/react-router'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { EngineChatReadbackSchema, collaborationContractFixtures } from '@foreman-code/contracts'
import { Button, Textarea } from '../../shared/ui/nocturne'
import { resolveRunsSelectorBoardLocation, RunsSelectorSearchSchema } from '../runs-selector/search'
import { useWorkflowSidePanel } from './useWorkflowSidePanel'
import { WorkflowMemoryDialog, WorkflowSidePanel } from './WorkflowSidePanel'
import { WorkflowOperatorChat, WorkflowOperatorDockProvider } from './WorkflowOperatorDock'
import { useWorkflowOperatorDock } from './operatorDockContext'
import { OperatorChatVisibilityProvider } from '../operator-chat/visibility'

afterEach(() => { cleanup(); vi.restoreAllMocks() })

/** A public consumer of the shell slots. Its local draft owner outlives selected bodies. */
function ShellFixture() {
  const location = useLocation()
  const resolved = resolveRunsSelectorBoardLocation(location.pathname, location.search)
  const side = useWorkflowSidePanel('workspace', 'workflow', resolved.run)
  const [host, setHost] = useState<HTMLDivElement | null>(null)
  const [draft, setDraft] = useState('')
  useWorkflowOperatorDock(side.scope, host, side.panel.kind === 'operator', side.memoryOpen, side.selectPanel, side.closeOperator)
  const readback = EngineChatReadbackSchema.parse(collaborationContractFixtures.executionReadback)
  return <>
    <nav aria-label="Board controls">
      <Button onClick={() => side.selectPanel({ kind: 'agent', nodeId: 'node-a', tab: 'settings' })}>Open Agent settings</Button>
      <Button onClick={() => side.selectPanel({ kind: 'group_chat' })}>Open Group chat</Button>
      <Button onClick={() => side.setMemoryOpen(true)}>Memory board</Button>
      <Button onClick={() => side.selectView('overview')}>Overview</Button>
      <Button onClick={() => side.selectView('graph')}>Graph</Button>
    </nav>
    <main aria-label="Board canvas">{side.view === 'overview' ? 'Overview is not available yet.' : 'Editing surface'}
      <p>{readback.messages[0]!.content}</p>
    </main>
    <WorkflowSidePanel scope={side.scope} opener={side.opener} runId={resolved.run?.runId}
      selection={side.panel} agentSelection={side.agentSelection} onSelect={side.selectPanel}
      bodyRef={setHost} modalOpen={side.memoryOpen} />
    {host && side.panel.kind === 'agent' && !side.panel.executionId && !side.memoryOpen
      ? createPortal(<div role="region" aria-label="Fixture transcript" className="fixture-scroll">
        <Textarea autoFocus label="Agent settings draft" value={draft}
          onChange={event => setDraft(event.target.value)} /></div>, host) : null}
    <WorkflowMemoryDialog open={side.memoryOpen} onOpenChange={side.setMemoryOpen} />
  </>
}

function mount(entry: string) {
  const root = createRootRoute({ component: Outlet })
  const board = createRoute({ getParentRoute: () => root, path: '/workspaces/$workspaceId',
    validateSearch: RunsSelectorSearchSchema.parse, component: ShellFixture })
  const pinned = createRoute({ getParentRoute: () => root,
    path: '/workspaces/$workspaceId/workflows/$workflowId/runs/$runId/graph/$workflowVersionId/3',
    validateSearch: RunsSelectorSearchSchema.parse, component: ShellFixture })
  const router = createRouter({ routeTree: root.addChildren([board, pinned]),
    history: createMemoryHistory({ initialEntries: [entry] }) })
  render(<OperatorChatVisibilityProvider enabled={false}><WorkflowOperatorDockProvider>
    <RouterProvider router={router} /><WorkflowOperatorChat />
  </WorkflowOperatorDockProvider></OperatorChatVisibilityProvider>)
  return router
}

describe('disabled collaboration shell through navigation and rendered controls', () => {
  it('explains a hidden Operator destination without mounting a conversation or making requests', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch'), user = userEvent.setup()
    mount('/workspaces/workspace?workflowId=workflow&boardPanel=operator')
    expect(await screen.findByRole('status')).toHaveTextContent('Operator chat is hidden in Agent settings.')
    expect(screen.queryByRole('dialog', { name: 'Operator chat' })).not.toBeInTheDocument()
    expect(screen.queryByRole('textbox', { name: 'Message' })).not.toBeInTheDocument()
    await user.click(screen.getByRole('button', { name: 'Back to Board' }))
    expect(screen.queryByRole('status')).not.toBeInTheDocument()
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps local drafts, retained selection and width across destination, modal and history changes', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const router = mount('/workspaces/workspace?workflowId=workflow')
    const user = userEvent.setup()
    const opener = await screen.findByRole('button', { name: 'Open Agent settings' })
    await user.click(opener)
    await user.type(await screen.findByRole('textbox', { name: 'Agent settings draft' }), 'Keep this unsaved edit')
    const rail = within(screen.getByRole('complementary', { name: 'Workflow side panel' }))
    const width = rail.getByRole('slider', { name: 'Panel width' })
    fireEvent.change(width, { target: { value: '520' } })
    const retainedWidth = width.getAttribute('aria-valuetext')
    fireEvent.scroll(screen.getByRole('region', { name: 'Fixture transcript' }), { target: { scrollTop: 125 } })
    await user.click(rail.getByRole('button', { name: /^Group chat$/ }))
    expect(await screen.findByText('Group chat is not available yet.')).toBeVisible()
    expect(screen.queryByRole('textbox', { name: 'Agent settings draft' })).not.toBeInTheDocument()
    expect(router.state.location.search).toMatchObject({ boardPanel: 'group_chat', boardNodeId: 'node-a', boardAgentTab: 'settings' })
    await act(async () => { router.history.back() })
    expect(await screen.findByRole('textbox', { name: 'Agent settings draft' })).toHaveValue('Keep this unsaved edit')
    expect(screen.getByRole('region', { name: 'Fixture transcript' }).scrollTop).toBe(125)
    await act(async () => { router.history.forward() })
    await screen.findByText('Group chat is not available yet.')
    await user.click(rail.getByRole('button', { name: /^Agent$/ }))
    expect(await screen.findByRole('textbox', { name: 'Agent settings draft' })).toHaveValue('Keep this unsaved edit')
    expect(rail.getByRole('slider', { name: 'Panel width' })).toHaveAttribute('aria-valuetext', retainedWidth)
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
    await user.click(screen.getByRole('button', { name: 'Open Group chat' }))
    await waitFor(() => expect(router.state.location.search).toMatchObject({ workflowId: 'workflow',
      runId: 'run-a', workflowVersionId: 'version-a', executionSemanticsVersion: 3,
      boardPanel: 'group_chat', boardNodeId: 'node-a', boardExecutionId: 'execution-a' }))
    await user.click(within(screen.getByRole('complementary', { name: 'Workflow side panel' })).getByRole('button', { name: 'Browser' }))
    expect(await screen.findByText(/No browser session has been started/)).toBeVisible()
    await user.click(screen.getByRole('button', { name: /^Overview$/ }))
    await user.click(screen.getByRole('button', { name: /^Memory board$/ }))
    await screen.findByRole('dialog', { name: 'Memory board' })
    expect(router.state.location.search).toMatchObject({ runId: 'run-a', workflowVersionId: 'version-a',
      boardView: 'overview', boardPanel: 'browser', boardExecutionId: 'execution-a', boardMemory: true })
    expect(fetch).not.toHaveBeenCalled()
  })

  it('keeps a query-selected Run responsive across panel changes and browser history', async () => {
    const fetch = vi.spyOn(globalThis, 'fetch')
    const user = userEvent.setup()
    const router = mount('/workspaces/workspace?workflowId=workflow&runId=run-a&workflowVersionId=version-a&executionSemanticsVersion=3')
    await user.click(await screen.findByRole('button', { name: 'Open Group chat' }))
    expect(await screen.findByText('Group chat is not available yet.')).toBeVisible()
    await user.click(screen.getByRole('button', { name: /^Overview$/ }))
    expect(screen.getByRole('main', { name: 'Board canvas' })).toHaveTextContent('Overview is not available yet.')
    await act(async () => { router.history.back() })
    await waitFor(() => expect(screen.getByRole('main', { name: 'Board canvas' })).toHaveTextContent('Editing surface'))
    expect(router.state.location.search).toMatchObject({ workflowId: 'workflow', runId: 'run-a',
      workflowVersionId: 'version-a', executionSemanticsVersion: 3, boardPanel: 'group_chat' })
    expect(fetch).not.toHaveBeenCalled()
  })
})

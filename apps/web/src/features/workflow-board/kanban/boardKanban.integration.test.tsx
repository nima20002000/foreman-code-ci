// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it, vi } from 'vitest'
import type { WorkflowKanbanLayout } from '@foreman-code/contracts'
import { server } from '../../../mocks/server'
import { createCurrentBoardMock } from '../../../shared/mocks/currentBoard'
import { fixture } from '../../graph/nextDraft/core.cases'
import { createMemoryBoardHandlers } from '../../memory-boards/mocks'
import { createMemoryTestPort, memoryTestCard, memoryTestIds, memoryTestTime } from '../../memory-boards/testing'
import type { MemoryChange } from '../../memory-boards'
import { installFlowLayout } from '../../run-board/testFlowLayout'
import { installBoardTestLifecycle, mountMeasuredBoard } from '../eng05D.testSupport'

installBoardTestLifecycle()

class MemorySource extends EventTarget {
  static instances: MemorySource[] = []
  constructor(readonly url: string) { super(); MemorySource.instances.push(this) }
  close() {}
}

/** A two-Agent workflow Board with its memory board and a server-kept Kanban layout. */
function install(suffix: string, layout: WorkflowKanbanLayout = { visible: false, frame: null }) {
  installFlowLayout(1000, 720)
  MemorySource.instances = []
  vi.stubGlobal('EventSource', MemorySource)
  const context = fixture(['coder', 'coder'])
  const graph = { ...context.draft.graph, workspaceId: `workspace-${suffix}` }
  const mock = createCurrentBoardMock({ workspaceId: graph.workspaceId, agents: context.agents.map((item) => item.agent), initialWorkflow: graph })
  const release = memoryTestCard({ id: 'card-release', title: 'Prepare release notes', status: 'doing' })
  const docs = memoryTestCard({ id: 'card-docs', title: 'Update the docs' })
  const memory = createMemoryTestPort({ cards: [release, docs], scope: { kind: 'workflow', workspaceId: graph.workspaceId, workflowId: graph.id } })
  const stored = { layout }
  const saves: WorkflowKanbanLayout[] = []
  const path = `*/api/management/workspaces/${graph.workspaceId}/workflows/${graph.id}/kanban-layout`
  const scope = { workspaceId: graph.workspaceId, workflowId: graph.id }
  server.use(http.get(path, () => HttpResponse.json({ ...scope, layout: stored.layout })),
    http.put(path, async ({ request }) => {
      stored.layout = (await request.json() as { layout: WorkflowKanbanLayout }).layout
      saves.push(stored.layout)
      return HttpResponse.json({ ...scope, layout: stored.layout })
    }), ...mock.handlers, ...createMemoryBoardHandlers(memory.port))
  return { graph, memory, stored, saves, release, docs, href: `/workspaces/${graph.workspaceId}?workflowId=${graph.id}` }
}
const canvas = () => document.querySelector<HTMLElement>('[aria-label="Editable workflow graph"]')!
function placed(id: string) {
  const node = document.querySelector<HTMLElement>(`.react-flow__node[data-id="${id}"]`)!
  const match = /translate\((-?[\d.]+)px,\s*(-?[\d.]+)px\)/.exec(node.style.transform)!
  return { x: Number(match[1]), y: Number(match[2]) }
}
/** Opens the newest memory stream created after `after` earlier streams. */
async function streamOpened(after = 0) {
  let source: MemorySource | undefined
  await waitFor(() => {
    source = MemorySource.instances.slice(after).find((item) => item.url.includes(memoryTestIds.board))
    expect(source).toBeDefined()
  })
  act(() => { source!.dispatchEvent(new Event('open')) })
  return source!
}

it('adds the Kanban from the toolbar and keeps its moved place and cards across a reload', async () => {
  const board = install('kanban-layout')
  const user = userEvent.setup()
  const first = await mountMeasuredBoard(board.href)
  // Off by default: the toolbar's Kanban button puts it on the Board.
  const toggle = await screen.findByRole('button', { name: 'Kanban' })
  await waitFor(() => expect(toggle).toBeEnabled())
  expect(toggle).toHaveAttribute('aria-pressed', 'false')
  expect(screen.queryByRole('region', { name: 'Kanban' })).not.toBeInTheDocument()
  await user.click(toggle)
  await waitFor(() => expect(board.saves).toEqual([{ visible: true, frame: null }]))
  const kanban = await screen.findByRole('region', { name: 'Kanban' })
  expect(canvas()).toContainElement(kanban)
  await streamOpened()
  expect(await within(kanban).findByRole('button', { name: 'Prepare release notes' })).toBeVisible()
  expect(within(within(kanban).getByRole('region', { name: 'Doing' })).getByRole('button', { name: 'Prepare release notes' })).toBeVisible()
  expect(within(within(kanban).getByRole('region', { name: 'Todo' })).getByRole('button', { name: 'Update the docs' })).toBeVisible()
  expect(board.saves).toHaveLength(1)

  // Dragged by its bar, the Kanban keeps its new place on the server.
  const before = placed('board-kanban')
  const bar = kanban.querySelector<HTMLElement>('.board-kanban-bar h2')!
  const view = bar.ownerDocument.defaultView!
  const pointer = (type: string, x: number, y: number) => {
    const event = new view.MouseEvent(type, { bubbles: true, cancelable: true, clientX: x, clientY: y, button: 0, buttons: 1 })
    Object.defineProperty(event, 'view', { value: view })
    return event
  }
  act(() => { bar.dispatchEvent(pointer('mousedown', 100, 100)) })
  act(() => { view.dispatchEvent(pointer('mousemove', 160, 150)) })
  act(() => { view.dispatchEvent(pointer('mousemove', 220, 200)) })
  act(() => { view.dispatchEvent(pointer('mouseup', 220, 200)) })
  const moved = placed('board-kanban')
  expect(moved).not.toEqual(before)
  await waitFor(() => expect(board.saves.at(-1)).toMatchObject({ visible: true, frame: { x: Math.round(moved.x), y: Math.round(moved.y) } }))

  // After a reload it comes back at the same place with the same cards.
  first.unmount()
  const earlier = MemorySource.instances.length
  await mountMeasuredBoard(board.href)
  const again = await screen.findByRole('region', { name: 'Kanban' })
  expect(placed('board-kanban')).toEqual({ x: Math.round(moved.x), y: Math.round(moved.y) })
  await streamOpened(earlier)
  expect(await within(again).findByRole('button', { name: 'Update the docs' })).toBeVisible()
  expect(board.memory.calls.filter((call) => call.method === 'mutate')).toEqual([])
  expect([...board.memory.cards.keys()].sort()).toEqual(['card-docs', 'card-release'])
})

it('opens a card, closes the Kanban into the dock, restores it, and hides it without changing its cards', async () => {
  const frame = { x: 700, y: 100, width: 760, height: 460 }
  const board = install('kanban-dock', { visible: true, frame })
  const user = userEvent.setup()
  await mountMeasuredBoard(board.href)
  const again = await screen.findByRole('region', { name: 'Kanban' })
  await streamOpened()

  // A card opens the shared memory detail directly, in the same window used for editing.
  await user.click(await within(again).findByRole('button', { name: 'Prepare release notes' }))
  const dialog = await screen.findByRole('dialog', { name: 'Memory board' })
  await user.click(within(dialog).getByRole('button', { name: /close memory board/i }))
  await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Memory board' })).not.toBeInTheDocument())
  expect(board.memory.calls.filter((call) => call.method === 'mutate')).toEqual([])
  expect([...board.memory.cards.keys()].sort()).toEqual(['card-docs', 'card-release'])

  // Its X only minimizes it into the dock: the saved layout and the cards stay, and the dock item restores it.
  const saved = board.saves.length
  await user.click(within(again).getByRole('button', { name: 'Close Kanban to the dock' }))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Kanban' })).not.toBeInTheDocument())
  await user.click(screen.getByRole('button', { name: /^Restore Kanban/ }))
  expect(await screen.findByRole('region', { name: 'Kanban' })).toBeInTheDocument()
  expect(placed('board-kanban')).toEqual({ x: frame.x, y: frame.y })
  expect(board.saves).toHaveLength(saved)

  // Pressed again, the toolbar button takes it off the Board; its cards stay.
  await user.click(screen.getByRole('button', { name: 'Kanban' }))
  await waitFor(() => expect(board.saves.at(-1)).toMatchObject({ visible: false }))
  await waitFor(() => expect(screen.queryByRole('region', { name: 'Kanban' })).not.toBeInTheDocument())
  expect(screen.queryByRole('button', { name: /^Restore Kanban/ })).not.toBeInTheDocument()
  expect([...board.memory.cards.keys()].sort()).toEqual(['card-docs', 'card-release'])
})

it('shows which Agent just changed a card on that card only, with a light from the Agent node', async () => {
  const board = install('kanban-activity', { visible: true, frame: { x: 700, y: 0, width: 760, height: 460 } })
  await mountMeasuredBoard(board.href)
  const kanban = await screen.findByRole('region', { name: 'Kanban' })
  const source = await streamOpened()
  await within(kanban).findByRole('button', { name: 'Prepare release notes' })
  const change = (id: string, sequence: number, cardId: string, actor: MemoryChange['actor'], subject?: boolean): MemoryChange => ({
    id, boardId: memoryTestIds.board, sequence, boardRevision: sequence, entity: 'card', entityId: cardId, entityRevision: sequence,
    actor, occurredAt: memoryTestTime, ...(subject ? { provenance: { subject: { kind: 'execution', agent: {
      workspaceId: board.graph.workspaceId, workflowId: board.graph.id, workflowNodeId: 'node-1', agentId: 'agent-1',
      productRole: 'coder', displayName: 'Agent 1', configurationVersionId: 'configuration-1' },
    execution: { runId: 'run-1', workflowVersionId: 'workflow-version-1', executionId: 'execution-1', attempt: 1 } } } } : {}),
  })
  const send = (value: MemoryChange) => act(() => { source.dispatchEvent(new MessageEvent('change', { data: JSON.stringify(value) })) })

  // A person's own edit is not announced as Agent activity.
  send(change('change-person', 5, board.docs.id, { kind: 'operator', id: 'user-fixture', displayName: 'Sam Lee' }))
  send(change('change-agent', 6, board.release.id, { kind: 'agent', id: 'agent-1', displayName: 'Agent 1' }, true))
  const updated = await within(kanban).findByText('Updated by Agent 1')
  expect(updated.closest('[data-card-id]')).toHaveAttribute('data-card-id', board.release.id)
  expect(within(kanban).getAllByText(/^Updated by /)).toHaveLength(1)
  expect(within(updated.closest<HTMLElement>('[data-card-id]')!).getByRole('button', { name: 'Prepare release notes' })).toBeVisible()
  expect(await screen.findByText('Card updated')).toBeInTheDocument()
})

it('opens a card in its own window with what its Agent did and every update across Runs', async () => {
  const board = install('kanban-card-window', { visible: true, frame: { x: 700, y: 0, width: 760, height: 460 } })
  const node = board.graph.nodes[0]!
  if (node.kind === 'job') throw new Error('The fixture starts with an Agent node')
  const agent ={ workspaceId: board.graph.workspaceId, workflowId: board.graph.id, workflowNodeId: node.id, agentId: node.agentId }
  board.memory.cards.set(board.release.id, { ...board.release, status: 'done', completionKind: 'completed', assignee: agent,
    body: 'Drafted the release notes.\nLinked the changelog.' })
  const update = (id: string, sequence: number, changes: MemoryChange['changes'], runId: string): MemoryChange => ({
    id, boardId: memoryTestIds.board, sequence, boardRevision: sequence, entity: 'card', entityId: board.release.id, entityRevision: sequence,
    actor: { kind: 'agent', id: node.agentId, displayName: 'Release Agent' }, occurredAt: memoryTestTime, changes,
    provenance: { work: { kind: 'activation', runId, workflowVersionId: 'workflow-version-1', activationId: `activation-${runId}` } } })
  board.memory.control.history = [
    update('change-2', 3, { status: { before: 'doing', after: 'done' } }, 'run-second'),
    update('change-1', 2, { body: { before: '', after: 'Drafted the release notes.' }, status: { before: 'done', after: 'doing' } }, 'run-first'),
    { ...update('change-0', 1, { title: { before: null, after: 'Prepare release notes' }, body: { before: null, after: '' },
      reason: { before: null, after: null }, status: { before: null, after: 'doing' } }, 'run-first'), entityRevision: 1 },
  ]
  await mountMeasuredBoard(board.href)
  const kanban = await screen.findByRole('region', { name: 'Kanban' })
  await streamOpened()
  await userEvent.click(await within(kanban).findByRole('button', { name: 'Prepare release notes' }))
  const window = await screen.findByRole('dialog', { name: 'Memory board' })
  expect(within(window).getByText('Done')).toBeVisible()
  expect(within(window).getByText(/Drafted the release notes\.\s+Linked the changelog\./)).toBeVisible()
  await userEvent.click(within(window).getByRole('button', { name: 'History', exact: true }))
  const updates = within(window).getAllByText(/Release Agent updated this card/)
  expect(updates).toHaveLength(3)
  expect(within(window).getAllByText(/Run run-firs/)).toHaveLength(2)
  expect(within(window).getByText(/Run run-seco/)).toBeVisible()
  // The same history preserves exact before/after values for every recorded change.
  await userEvent.click(within(window).getAllByText('status changed')[0]!)
  expect(within(window).getByText('Previously: doing')).toBeVisible()
  expect(within(window).getByText('Saved: done')).toBeVisible()
  await userEvent.click(within(window).getByText('body changed'))
  expect(within(window).getByText('Saved: Drafted the release notes.')).toBeVisible()
  await userEvent.click(within(window).getByText('title changed'))
  expect(within(window).getByText('Saved: Prepare release notes')).toBeVisible()
  expect(screen.getAllByRole('dialog')).toHaveLength(1)
}, 20_000)


it('opens memory from an empty Kanban so its first card can be created', async () => {
  const board = install('kanban-empty-memory', { visible: true, frame: null })
  board.memory.cards.clear()
  await mountMeasuredBoard(board.href)
  await streamOpened()
  const kanban = await screen.findByRole('region', { name: 'Kanban' })
  await userEvent.click(within(kanban).getByRole('button', { name: 'Open memory board' }))
  const dialog = await screen.findByRole('dialog', { name: 'Memory board' })
  expect(await within(dialog).findByRole('button', { name: 'Add card' })).toBeVisible()
}, 15_000)

it('edits a Kanban card inside the same shared memory window', async () => {
  const board = install('kanban-edit', { visible: true, frame: null })
  await mountMeasuredBoard(board.href)
  await streamOpened()
  const kanban = await screen.findByRole('region', { name: 'Kanban' })
  await userEvent.click(await within(kanban).findByRole('button', { name: 'Prepare release notes' }))
  const dialog = await screen.findByRole('dialog')
  await userEvent.click(await within(dialog).findByRole('button', { name: 'Edit', exact: true }))
  expect(screen.getByRole('dialog')).toBe(dialog)
  expect(within(dialog).getByRole('textbox', { name: 'Title' })).toHaveValue('Prepare release notes')
  expect(within(dialog).getByRole('button', { name: 'Save card' })).toBeVisible()
}, 15_000)

it('labels Kanban memory as live and shared across Runs', async () => {
  const board = install('kanban-scope', { visible: true, frame: null })
  await mountMeasuredBoard(board.href)
  const kanban = await screen.findByRole('region', { name: 'Kanban' })
  expect(within(kanban).getByText('Live memory · shared across runs')).toBeVisible()
  await streamOpened()
  await userEvent.click(await within(kanban).findByRole('button', { name: 'Prepare release notes' }))
  expect(within(await screen.findByRole('dialog')).getByText('Live memory · shared across runs')).toBeVisible()
}, 15_000)

it('restores a minimized Kanban from its toolbar without removing its saved layout', async () => {
  const board = install('kanban-toolbar-restore', { visible: true, frame: { x: 500, y: 100, width: 760, height: 460 } })
  await mountMeasuredBoard(board.href)
  const kanban = await screen.findByRole('region', { name: 'Kanban' })
  await userEvent.click(within(kanban).getByRole('button', { name: 'Close Kanban to the dock' }))
  await screen.findByRole('button', { name: /^Restore Kanban/ })
  const before = board.saves.length
  const toolbar = screen.getByRole('button', { name: 'Kanban', exact: true })
  expect(toolbar).toHaveAttribute('aria-pressed', 'false')
  await userEvent.click(toolbar)
  expect(await screen.findByRole('region', { name: 'Kanban' })).toBeVisible()
  expect(board.saves).toHaveLength(before)
  expect(board.stored.layout.visible).toBe(true)
}, 15_000)

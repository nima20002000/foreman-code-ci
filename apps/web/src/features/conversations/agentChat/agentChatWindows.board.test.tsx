// @vitest-environment jsdom
import { act, fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { LocalHumanAccessSchema } from '@foreman-code/contracts/management'
import type { AgentChatContext } from '@foreman-code/contracts/agent-chat'
import { server } from '../../../mocks/server'
import { agentChatFixtureFor, agentChatTestActions, createAgentChatMock } from '../../../shared/mocks/agentChatHandlers'
import { installBoardTestLifecycle, mountMeasuredBoard } from '../../workflow-board/eng05D.testSupport'
import { inspectionBoardFixture } from '../../workflow-board/inspect/inspectionFixtures'
import { useConversationDraftStore } from '../conversationDraftStore'
import { providerFixture } from './f7.testSupport'
import { installChatSource } from './testSupport'
import { useChatWindowsStore } from './agentChatWindows'

installBoardTestLifecycle()
afterEach(() => {
  useConversationDraftStore.getState().clearAllDrafts()
  useChatWindowsStore.setState({ open: {}, frames: {}, focus: {} })
})

/** The mounted Board route with MSW: selecting an Agent node on the canvas opens floating chat windows. */
async function mountDraftBoard(suffix: string) {
  installChatSource()
  const fixture = await inspectionBoardFixture(suffix), saved = fixture.runs.before.scope
  const [first, second] = fixture.after.definition.nodes.map((node) => node as { id: string; name?: string; agentId: string })
  const contexts = [first!, second!].map((node): AgentChatContext => ({ workspaceId: saved.workspaceId,
    workflowId: saved.workflowId, workflowNodeId: node.id, agentId: node.agentId }))
  const chat = createAgentChatMock(agentChatFixtureFor(providerFixture('codex'), contexts[0]!))
  chat.setState(agentChatFixtureFor(providerFixture('codex'), contexts[1]!))
  server.use(...chat.handlers.slice(1), ...fixture.mock.handlers)
  server.use(http.get('/api/local-human', () => HttpResponse.json(LocalHumanAccessSchema.parse({ principal: {
    id: 'chat-windows-tester', name: 'Chat window tester', expiresAt: '2099-01-01T00:00:00.000Z', grants: [{
      scope: { workspaceIds: [saved.workspaceId] },
      actions: ['workspaces:read', 'workflows:read', 'agents:read', 'graph:read', 'interactions:read', 'runs:read', ...agentChatTestActions],
    }],
  } }))))
  await mountMeasuredBoard(`/workspaces/${saved.workspaceId}?workflowId=${saved.workflowId}`)
  const names = { first: first!.name!, second: second!.name! }
  // fireEvent: user-event's mousedown has no window view, which React Flow's node drag handler requires.
  const node = (name: string) => screen.findByRole('button', { name: new RegExp(`^${name},`) })
  const windowNamed = (name: string) => screen.findByRole('dialog', { name: `${name} chat` })
  return { names, node, windowNamed, chat, contexts }
}
const px = (element: HTMLElement, property: 'left' | 'top' | 'width' | 'height') => parseFloat(element.style[property])

describe('floating Agent chat windows on the Board', () => {
  it.each(['window', 'board'] as const)('loads the composer without stealing focus from the %s', async (focusTarget) => {
    const { names, node, windowNamed, chat, contexts } = await mountDraftBoard(`chatwin-loading-${focusTarget}`)
    let release!: () => void
    const pending = new Promise<void>((resolve) => { release = resolve })
    server.use(http.get('/api/workspaces/:workspaceId/agent-chat', async () => {
      await pending
      return HttpResponse.json(chat.getState(contexts[0]!))
    }))
    const selectedNode = await node(names.first)
    fireEvent.click(selectedNode)
    const chatWindow = await windowNamed(names.first)
    await waitFor(() => expect(chatWindow).toHaveFocus())
    if (focusTarget === 'board') await act(async () => selectedNode.focus())

    await act(async () => release())

    const input = await within(chatWindow).findByRole('textbox', { name: 'Message' })
    expect(input).toBeEnabled()
    await waitFor(() => expect(focusTarget === 'window' ? input : selectedNode).toHaveFocus())
  }, 30_000)

  it('opens that Agent chat when a node is selected and keeps several windows open', async () => {
    const { names, node, windowNamed } = await mountDraftBoard('chatwin-open')
    fireEvent.click(await node(names.first))
    const first = await windowNamed(names.first)
    expect(await within(first).findByRole('textbox', { name: 'Message' })).toBeEnabled()
    fireEvent.click(await node(names.second))
    const second = await windowNamed(names.second)
    expect(within(second).getByTestId('agent-conversation')).not.toBe(within(first).getByTestId('agent-conversation'))
    expect(screen.getAllByRole('dialog', { name: /chat$/ })).toHaveLength(2)
    // Selecting an open Agent again focuses and raises its window instead of opening another.
    fireEvent.click(await node(names.first))
    expect(screen.getAllByRole('dialog', { name: /chat$/ })).toHaveLength(2)
    await waitFor(() => expect(first.contains(document.activeElement)).toBe(true))
    expect(Number(first.style.zIndex)).toBeGreaterThan(Number(second.style.zIndex))
  }, 30_000)

  it('stays open when the Board background is clicked and closes only through its own X', async () => {
    const { names, node, windowNamed } = await mountDraftBoard('chatwin-close')
    fireEvent.click(await node(names.first))
    fireEvent.click(await node(names.second))
    const first = await windowNamed(names.first), second = await windowNamed(names.second)
    fireEvent.click(document.querySelector<HTMLElement>('.react-flow__pane')!)
    fireEvent.mouseDown(document.body)
    expect(first).toBeVisible(); expect(second).toBeVisible()
    await userEvent.click(within(first).getByRole('button', { name: `Close ${names.first}` }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: `${names.first} chat` })).not.toBeInTheDocument())
    expect(screen.getByRole('dialog', { name: `${names.second} chat` })).toBe(second)
  }, 30_000)

  it('moves by its header and resizes by its handle, and a reselected window keeps its place', async () => {
    const { names, node, windowNamed } = await mountDraftBoard('chatwin-frame')
    fireEvent.click(await node(names.first))
    const chat = await windowNamed(names.first)
    const left = px(chat, 'left'), top = px(chat, 'top'), width = px(chat, 'width'), height = px(chat, 'height')
    const title = within(chat).getByRole('heading', { name: names.first })
    fireEvent.pointerDown(title, { pointerId: 1, button: 0, clientX: 300, clientY: 200 })
    fireEvent.pointerMove(title, { pointerId: 1, clientX: 260, clientY: 230 })
    fireEvent.pointerUp(title, { pointerId: 1, clientX: 260, clientY: 230 })
    expect(px(chat, 'left')).toBe(left - 40); expect(px(chat, 'top')).toBe(top + 30)
    expect(px(chat, 'width')).toBe(width)
    // The left edge grows the window leftward; the bottom-right corner grows it down.
    const edge = within(chat).getByTestId('agent-chat-resize-w')
    fireEvent.pointerDown(edge, { pointerId: 2, button: 0, clientX: 500, clientY: 500 })
    fireEvent.pointerMove(edge, { pointerId: 2, clientX: 470, clientY: 500 })
    fireEvent.pointerUp(edge, { pointerId: 2, clientX: 470, clientY: 500 })
    expect(px(chat, 'width')).toBe(width + 30); expect(px(chat, 'left')).toBe(left - 70)
    const corner = within(chat).getByTestId('agent-chat-resize-se')
    fireEvent.pointerDown(corner, { pointerId: 3, button: 0, clientX: 500, clientY: 500 })
    fireEvent.pointerMove(corner, { pointerId: 3, clientX: 500, clientY: 520 })
    fireEvent.pointerUp(corner, { pointerId: 3, clientX: 500, clientY: 520 })
    expect(px(chat, 'height')).toBe(height + 20); expect(px(chat, 'width')).toBe(width + 30)
    await userEvent.click(within(chat).getByRole('button', { name: `Close ${names.first}` }))
    await waitFor(() => expect(chat).not.toBeInTheDocument())
    fireEvent.click(await node(names.first))
    const reopened = await windowNamed(names.first)
    expect([px(reopened, 'left'), px(reopened, 'top'), px(reopened, 'width'), px(reopened, 'height')])
      .toEqual([left - 70, top + 30, width + 30, height + 20])
  }, 30_000)

  it('raises a window when it is clicked and closes the focused one with Escape', async () => {
    const { names, node, windowNamed } = await mountDraftBoard('chatwin-raise')
    fireEvent.click(await node(names.first))
    fireEvent.click(await node(names.second))
    const first = await windowNamed(names.first), second = await windowNamed(names.second)
    expect(Number(second.style.zIndex)).toBeGreaterThan(Number(first.style.zIndex))
    fireEvent.pointerDown(within(first).getByRole('heading', { name: names.first }), { pointerId: 1, button: 0, clientX: 1, clientY: 1 })
    expect(Number(first.style.zIndex)).toBeGreaterThan(Number(second.style.zIndex))
    within(first).getByRole('textbox', { name: 'Message' }).focus()
    await userEvent.keyboard('{Escape}')
    await waitFor(() => expect(screen.queryByRole('dialog', { name: `${names.first} chat` })).not.toBeInTheDocument())
    expect(screen.getByRole('dialog', { name: `${names.second} chat` })).toBeVisible()
  }, 30_000)

  it('brings a window to front when keyboard focus enters its composer', async () => {
    const { names, node, windowNamed } = await mountDraftBoard('chatwin-keyboard-focus')
    fireEvent.click(await node(names.first))
    const first = await windowNamed(names.first)
    const firstInput = await within(first).findByRole('textbox', { name: 'Message' })
    fireEvent.click(await node(names.second))
    const second = await windowNamed(names.second)
    const secondInput = await within(second).findByRole('textbox', { name: 'Message' })
    await act(async () => secondInput.focus())
    expect(Number(second.style.zIndex)).toBeGreaterThan(Number(first.style.zIndex))

    await act(async () => firstInput.focus())

    expect(firstInput).toHaveFocus()
    expect(Number(first.style.zIndex)).toBeGreaterThan(Number(second.style.zIndex))
    expect(screen.getAllByRole('dialog', { name: /chat$/ })).toHaveLength(2)
  }, 30_000)

  it('opens a new window beside the selected Agent instead of covering it, then keeps the person\'s position', async () => {
    const { names, node, windowNamed } = await mountDraftBoard('chatwin-placement')
    // The test Board is 1000x720; put the Agent where the window would normally open (right side).
    const rect = (left: number, top: number, width: number, height: number) =>
      ({ x: left, y: top, left, top, right: left + width, bottom: top + height, width, height, toJSON: () => ({}) })
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockImplementation(function (this: HTMLElement) {
      return this.matches('.react-flow__node') ? rect(640, 160, 200, 200) : rect(0, 0, 1000, 720)
    })
    fireEvent.click(await node(names.first))
    const chat = await windowNamed(names.first)
    const frame = { left: px(chat, 'left'), top: px(chat, 'top'), width: px(chat, 'width'), height: px(chat, 'height') }
    const separated = frame.left + frame.width <= 640 || frame.left >= 840 || frame.top + frame.height <= 160 || frame.top >= 360
    expect(separated).toBe(true)
    await userEvent.click(within(chat).getByRole('button', { name: `Close ${names.first}` }))
    fireEvent.click(await node(names.first))
    const reopened = await windowNamed(names.first)
    expect([px(reopened, 'left'), px(reopened, 'top')]).toEqual([frame.left, frame.top])
  }, 30_000)
})

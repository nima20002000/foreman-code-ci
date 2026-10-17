// @vitest-environment jsdom
import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, describe, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { LocalHumanAccessSchema } from '@foreman-code/contracts/management'
import type { AgentChatContext } from '@foreman-code/contracts/agent-chat'
import { server } from '../../mocks/server'
import { agentChatFixtureFor, agentChatTestActions, createAgentChatMock } from '../../shared/mocks/agentChatHandlers'
import { useChatWindowsStore } from '../conversations/agentChat/agentChatWindows'
import { useConversationDraftStore } from '../conversations/conversationDraftStore'
import { providerFixture } from '../conversations/agentChat/f7.testSupport'
import { installChatSource } from '../conversations/agentChat/testSupport'
import { useApprovalInboxStore } from '../approvals'
import { installBoardTestLifecycle, mountMeasuredBoard } from './eng05D.testSupport'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'

installBoardTestLifecycle()
afterEach(() => {
  useConversationDraftStore.getState().clearAllDrafts()
  useChatWindowsStore.setState({ open: {}, frames: {}, focus: {} })
  useApprovalInboxStore.setState({ open: false, workspaceId: '', workflowId: undefined })
})

/** The mounted Board route with MSW and two Agent nodes whose chats can be opened. */
async function mountBoard(suffix: string) {
  installChatSource()
  const fixture = await inspectionBoardFixture(suffix), saved = fixture.runs.before.scope
  const [first, second] = fixture.after.definition.nodes.map((node) => node as { id: string; name?: string; agentId: string })
  const contexts = [first!, second!].map((node): AgentChatContext => ({ workspaceId: saved.workspaceId,
    workflowId: saved.workflowId, workflowNodeId: node.id, agentId: node.agentId }))
  const chat = createAgentChatMock(agentChatFixtureFor(providerFixture('codex'), contexts[0]!))
  chat.setState(agentChatFixtureFor(providerFixture('codex'), contexts[1]!))
  server.use(...chat.handlers.slice(1), ...fixture.mock.handlers)
  server.use(http.get('/api/local-human', () => HttpResponse.json(LocalHumanAccessSchema.parse({ principal: {
    id: 'board-containers-tester', name: 'Board container tester', expiresAt: '2099-01-01T00:00:00.000Z', grants: [{
      scope: { workspaceIds: [saved.workspaceId] },
      actions: ['workspaces:read', 'workflows:read', 'agents:read', 'graph:read', 'interactions:read', 'runs:read', ...agentChatTestActions],
    }],
  } }))))
  await mountMeasuredBoard(`/workspaces/${saved.workspaceId}?workflowId=${saved.workflowId}`)
  return { names: { first: first!.name!, second: second!.name! } }
}
const z = (element: Element) => Number((element as HTMLElement).style.zIndex)
const chatWindow = (name: string) => screen.findByRole('dialog', { name: `${name} chat` })
const openChat = async (name: string) => { fireEvent.click(await screen.findByRole('button', { name: `Open ${name} chat` })); return chatWindow(name) }
const addNodePanel = () => screen.getByRole('complementary', { name: 'Add node' })

describe('floating Board containers share one stacking order', () => {
  it('puts the newest opened container on top: chat windows, add-Agent panel, approval inbox and Activities', async () => {
    const user = userEvent.setup()
    const { names } = await mountBoard('containers-stack')
    const firstChat = await openChat(names.first)
    await user.click(await screen.findByRole('button', { name: 'Add agent or job to graph' }))
    expect(z(addNodePanel())).toBeGreaterThan(z(firstChat))
    await user.click(screen.getByRole('button', { name: /^Open human approval inbox/ }))
    const inbox = await screen.findByRole('dialog', { name: 'Human approval inbox' })
    const inboxRoot = inbox.closest<HTMLElement>('.approval-inbox-root')!
    expect(z(inboxRoot)).toBeGreaterThan(z(addNodePanel()))
    const secondChat = await openChat(names.second)
    expect(z(secondChat)).toBeGreaterThan(z(inboxRoot))
    expect(z(secondChat)).toBeGreaterThan(z(addNodePanel()))
    await user.click(await screen.findByRole('button', { name: 'Activities' }))
    const activities = await screen.findByRole('region', { name: 'Activities popover' })
    for (const other of [firstChat, secondChat, inboxRoot, addNodePanel()]) expect(z(activities)).toBeGreaterThan(z(other))
  }, 30_000)

  it('raises a container when it is clicked or focused, whichever it was before', async () => {
    const user = userEvent.setup()
    const { names } = await mountBoard('containers-raise')
    const firstChat = await openChat(names.first)
    await user.click(await screen.findByRole('button', { name: 'Add agent or job to graph' }))
    const panel = addNodePanel()
    expect(z(panel)).toBeGreaterThan(z(firstChat))
    fireEvent.pointerDown(within(firstChat).getByRole('heading', { name: names.first }), { pointerId: 1, button: 0, clientX: 1, clientY: 1 })
    expect(z(firstChat)).toBeGreaterThan(z(panel))
    fireEvent.pointerDown(within(panel).getByRole('button', { name: 'Add node' }), { pointerId: 1, button: 0, clientX: 1, clientY: 1 })
    expect(z(panel)).toBeGreaterThan(z(firstChat))
  }, 30_000)
})

describe('the add-Agent panel on the Board', () => {
  it('lists only available Agents to add and stays open when the Board is clicked or a node is selected', async () => {
    const user = userEvent.setup()
    const { names } = await mountBoard('containers-picker')
    await user.click(await screen.findByRole('button', { name: 'Add agent or job to graph' }))
    const panel = addNodePanel()
    expect(within(panel).queryByText(/Saved jobs|one-pass|Existing agent|Choose a node/i)).not.toBeInTheDocument()
    expect(within(panel).queryByRole('button', { name: 'Worker' })).not.toBeInTheDocument()
    expect(within(panel).getAllByRole('button', { name: /^Add / }).length).toBeGreaterThan(0)
    fireEvent.click(document.querySelector<HTMLElement>('.react-flow__pane')!)
    fireEvent.click(await screen.findByRole('button', { name: new RegExp(`^${names.first},`) }))
    await waitFor(() => expect(screen.getByRole('button', { name: new RegExp(`^${names.first},`) })).toHaveAttribute('aria-pressed', 'true'))
    await new Promise((resolve) => setTimeout(resolve, 50))
    expect(panel).toBeInTheDocument()
    expect(panel).toBeVisible()
    await user.click(within(panel).getByRole('button', { name: 'Close node picker' }))
    await waitFor(() => expect(panel).not.toBeInTheDocument())
  }, 30_000)
})

import type { ComponentProps } from 'react'
import { act, cleanup, fireEvent, screen, waitFor } from '@testing-library/react'
import type { QueryClient } from '@tanstack/react-query'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { agentChatFixtures, type AgentChatExecutionActivityPage, type AgentChatState } from '@foreman-code/contracts/agent-chat'
import { useConversationDraftStore } from '../../chat-core'
import { fixture } from '../../file-cards/testFixtures'
import type { MessageBubble } from '../../../shared/ui/nocturne'
import { installChatSource, mountChat } from './testSupport'
import { server } from '../../../mocks/server'

const renders = vi.hoisted(() => new Map<string, number>())
vi.mock('../../../shared/ui/nocturne', async importOriginal => {
  const original = await importOriginal<typeof import('../../../shared/ui/nocturne')>()
  return { ...original, MessageBubble: (props: ComponentProps<typeof MessageBubble>) => {
    if (props.dateTime) renders.set(props.dateTime, (renders.get(props.dateTime) ?? 0) + 1)
    return <original.MessageBubble {...props} />
  } }
})

const clients: QueryClient[] = []
const timestamps = ['2026-09-27T12:00:00.000Z', '2026-09-27T12:01:00.000Z', '2026-09-27T12:02:00.000Z']
beforeEach(() => { installChatSource(); renders.clear() })
afterEach(() => {
  cleanup()
  clients.splice(0).forEach(client => client.clear())
  useConversationDraftStore.getState().clearAllDrafts()
  vi.unstubAllGlobals()
})

it('keeps unchanged conversation message bubbles out of poll renders while updating text and delivery', async () => {
  const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
  state.messages.forEach((message, index) => { message.createdAt = timestamps[index]; message.revision = '1' })
  state.messages[0]!.attachments = []
  state.hasEarlierMessages = true
  const mounted = mountChat(state)
  clients.push(mounted.client)
  server.use(http.get('/api/workspaces/:workspaceId/agent-chat/conversations/:conversationId/history', () =>
    HttpResponse.json({ conversationId: state.conversation!.id, messages: state.messages, nextCursor: null })))
  await mounted.ready()
  await screen.findByText('It is a workflow engine.')
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Load earlier messages' })).not.toBeInTheDocument())
  const before = new Map(renders)
  const next = structuredClone(state)
  next.revision++
  next.messages.push({ id: 'another-reply', conversationId: state.conversation!.id, role: 'assistant',
    content: 'A new reply arrived', revision: '2', createdAt: timestamps[2], nativeMessageComplete: true })
  mounted.mock.setState(next)
  await act(async () => { await mounted.refresh() })
  await screen.findByText('A new reply arrived')
  for (const timestamp of timestamps.slice(0, 2)) expect(renders.get(timestamp)).toBe(before.get(timestamp))

  const changed = structuredClone(next)
  changed.revision++
  changed.messages[1] = { ...changed.messages[1]!, content: 'Updated reply', revision: '3' }
  changed.turns[0] = { ...changed.turns[0]!, delivery: 'canceled' }
  mounted.mock.setState(changed)
  await act(async () => { await mounted.refresh() })
  await screen.findByText('Updated reply')
  expect(screen.getByLabelText('Canceled')).toBeVisible()
  expect(renders.get(timestamps[1]!)).toBeGreaterThan(before.get(timestamps[1]!)!)
  expect(renders.get(timestamps[2]!)).toBe(1)
})

it('keeps retained user bubbles out of renders when the completed receipt window rotates', async () => {
  const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
  const turn = state.turns[0]!, message = state.messages[0]!
  const turns = Array.from({ length: 51 }, (_, index) => ({ ...turn, requestId: `request-${index}`,
    messageId: `message-${index}`, sequence: String(index + 1) }))
  const messages = turns.map((turn, index) => ({ ...message, id: turn.messageId, requestId: turn.requestId,
    revision: '1', content: `User message ${index}`, createdAt: new Date(Date.UTC(2026, 8, 27, 12, index)).toISOString() }))
  state.turns = turns.slice(0, 50)
  state.messages = messages.slice(0, 50)
  const mounted = mountChat(state)
  clients.push(mounted.client)
  await mounted.ready()
  await screen.findByText('User message 49')
  const before = new Map(renders)
  mounted.mock.setState({ ...state, revision: state.revision + 1, turns: turns.slice(1), messages })
  await act(async () => { await mounted.refresh() })
  await screen.findByText('User message 50')
  for (const message of messages.slice(1, 50)) expect(renders.get(message.createdAt)).toBe(before.get(message.createdAt))
  expect(screen.getByText('User message 0')).toBeVisible()
  expect(screen.getAllByLabelText('Completed')).toHaveLength(50)
})

it.each(['expired', 'removed'] as const)('keeps stale overlapping history bubbles out of renders after file metadata becomes %s', async fileState => {
  const state: AgentChatState = structuredClone(agentChatFixtures.idleAfterCompletion)
  const { workspaceId, workflowId, agentId } = state.context
  state.messages.forEach((message, index) => { message.createdAt = timestamps[index]; message.revision = '1' })
  state.messages[0]!.attachments = [fixture({ scope: { kind: 'temporary', chat: {
    kind: 'agent', workspaceId, workflowId, agentId, conversationId: state.conversation!.id,
  } } })]
  state.hasEarlierMessages = true
  const mounted = mountChat(state)
  clients.push(mounted.client)
  server.use(http.get('/api/workspaces/:workspaceId/agent-chat/conversations/:conversationId/history', () =>
    HttpResponse.json({ conversationId: state.conversation!.id, messages: state.messages, nextCursor: null })))
  await mounted.ready()
  await screen.findByText('It is a workflow engine.')
  fireEvent.click(screen.getByRole('button', { name: 'Load earlier messages' }))
  await waitFor(() => expect(screen.queryByRole('button', { name: 'Load earlier messages' })).not.toBeInTheDocument())
  const beforeChange = renders.get(timestamps[0]!)!
  const changed = structuredClone(state)
  changed.messages[0]!.attachments![0]!.file.state = fileState
  mounted.mock.setState(changed)
  await act(async () => { await mounted.refresh() })
  expect(await screen.findByText(fileState === 'expired' ? 'Expired' : 'Removed')).toBeVisible()
  expect(renders.get(timestamps[0]!)).toBeGreaterThan(beforeChange)
  const beforePoll = new Map(renders)
  const next = structuredClone(changed)
  next.revision++
  next.messages.push({ id: 'another-reply', conversationId: state.conversation!.id, role: 'assistant',
    content: 'Reply after file change', revision: '2', createdAt: timestamps[2], nativeMessageComplete: true })
  mounted.mock.setState(next)
  await act(async () => { await mounted.refresh() })
  await screen.findByText('Reply after file change')
  for (const timestamp of timestamps.slice(0, 2)) expect(renders.get(timestamp)).toBe(beforePoll.get(timestamp))
  expect(screen.getByText(fileState === 'expired' ? 'Expired' : 'Removed')).toBeVisible()
})

it('keeps retained execution message bubbles out of poll renders and expands the current message', async () => {
  const state: AgentChatState = structuredClone(agentChatFixtures.runActive)
  const page: AgentChatExecutionActivityPage = {
    mode: 'snapshot', cursor: 'first', hasMoreChanges: false, hasEarlierExecutions: false,
    executions: [{ executionId: 'execution', label: 'Execution', attempt: 1, state: 'completed', revision: '1', createdAt: timestamps[0]! }],
    items: timestamps.slice(0, 2).map((createdAt, index) => ({
      executionId: 'execution', id: `item-${index}`, sequence: String(index + 1), revision: '1',
      entry: { kind: 'message', message: { id: `message-${index}`, role: index === 0 ? 'user' : 'assistant',
        content: `Execution message ${index}`, createdAt, ...(index === 1 ? { truncation: { truncated: true, originalBytes: 100 } } : {}) } },
    })),
  }
  let response = page
  const expanded: string[] = []
  const mounted = mountChat(state)
  clients.push(mounted.client)
  server.use(http.get('/api/workspaces/:workspaceId/agent-chat/execution-activity', ({ request }) => {
    const itemId = new URL(request.url).searchParams.get('itemId')
    if (itemId) {
      expanded.push(itemId)
      const item = structuredClone(response.items.find(item => item.id === itemId)!)
      if (item.entry.kind !== 'message') throw new Error('Expected message')
      item.revision = '4'
      item.entry.message.content = 'Full execution message'
      delete item.entry.message.truncation
      return HttpResponse.json({ ...response, mode: 'item', items: [item] })
    }
    return HttpResponse.json(response)
  }))
  await screen.findByText('Execution message 1')
  const before = new Map(renders)
  const next = structuredClone(page)
  next.cursor = 'second'
  next.items.push({ executionId: 'execution', id: 'item-2', sequence: '3', revision: '2',
    entry: { kind: 'message', message: { id: 'message-2', role: 'assistant', content: 'New execution message', createdAt: timestamps[2] } } })
  const poll = async (incoming: AgentChatExecutionActivityPage) => {
    response = incoming
    await act(async () => { await mounted.client.refetchQueries({ predicate: query => query.queryKey.at(-1) === 'execution-activity' }) })
  }
  await poll(next)
  await screen.findByText('New execution message')
  for (const timestamp of timestamps.slice(0, 2)) expect(renders.get(timestamp)).toBe(before.get(timestamp))

  const changed = structuredClone(next)
  changed.cursor = 'third'
  changed.items.shift()
  const item = changed.items[0]!
  if (item.entry.kind !== 'message') throw new Error('Expected message')
  item.revision = '3'
  item.entry.message.content = 'Updated execution message'
  await poll(changed)
  await screen.findByText('Updated execution message')
  expect(screen.queryByText('Execution message 0')).not.toBeInTheDocument()
  expect(renders.get(timestamps[2]!)).toBe(1)
  fireEvent.click(screen.getByRole('button', { name: 'Show full message' }))
  await waitFor(() => expect(expanded).toEqual(['item-1']))
  await screen.findByText('Full execution message')
})

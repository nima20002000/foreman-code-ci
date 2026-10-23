import { expect, it, vi } from 'vitest'
import { OperatorConversationEvents } from './operatorChat.js'
import { AgentChatEvents } from './agentChat.js'

it.each([OperatorConversationEvents, AgentChatEvents])('keeps a later subscriber when an earlier unsubscribe runs again', Events => {
  const events = new Events()
  const unsubscribe = events.subscribe('conversation', () => {})
  unsubscribe()
  const received = vi.fn()
  events.subscribe('conversation', received)
  unsubscribe()
  events.publish('conversation', 'state', {})
  expect(received).toHaveBeenCalledOnce()
})

it.each([OperatorConversationEvents, AgentChatEvents])('delivers every event to owners and only that conversation to its subscribers', Events => {
  const events = new Events()
  const owner = vi.fn(), subscriber = vi.fn(), other = vi.fn()
  events.subscribeOwner(owner)
  events.subscribe('conversation', subscriber)
  events.subscribe('other', other)
  events.publish('conversation', 'state', { snapshotRequired: true })
  events.publish('conversation', 'error', {})
  expect(owner).toHaveBeenCalledTimes(2)
  expect(subscriber.mock.calls.map(([event]) => [event.id, event.type, event.data])).toEqual([
    [0, 'state', { snapshotRequired: true }], [1, 'error', {}]])
  expect(other).not.toHaveBeenCalled()
})

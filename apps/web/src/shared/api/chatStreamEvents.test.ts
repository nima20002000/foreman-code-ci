import { afterEach, expect, it, vi } from 'vitest'
import { z } from 'zod'
import { connectChatStream, createChatStreamSequence } from './chatStreamEvents'
import { openEventStreamScope } from './eventStream'

class Source extends EventTarget {
  static current: Source
  close = vi.fn()
  constructor(readonly url: string) { super(); Source.current = this }
}
afterEach(() => vi.unstubAllGlobals())

it('decodes named contract events, preserves transport handlers and detaches on abort', () => {
  vi.stubGlobal('EventSource', Source)
  const controller = new AbortController(), scope = openEventStreamScope(controller.signal)!
  const receive = vi.fn(), invalid = vi.fn(), open = vi.fn()
  connectChatStream(scope, '/api/chat/events', {
    schema: z.object({ cursor: z.string() }), events: ['changed', 'message'], receive, invalid, handlers: { open },
  })
  const source = Source.current
  expect(source.url).toBe('/api/chat/events')
  source.dispatchEvent(new Event('open'))
  expect(open).toHaveBeenCalledOnce()
  source.dispatchEvent(new MessageEvent('changed', { data: '{"cursor":"first"}' }))
  source.dispatchEvent(new MessageEvent('message', { data: '{"cursor":"second"}' }))
  expect(receive.mock.calls).toEqual([[{ cursor: 'first' }], [{ cursor: 'second' }]])
  source.dispatchEvent(new MessageEvent('changed', { data: 'malformed' }))
  source.dispatchEvent(new MessageEvent('changed', { data: '{"cursor":1}' }))
  expect(invalid).toHaveBeenCalledTimes(2)
  controller.abort()
  source.dispatchEvent(new MessageEvent('changed', { data: '{"cursor":"late"}' }))
  expect(source.close).toHaveBeenCalledOnce()
  expect(receive).toHaveBeenCalledTimes(2)
})

it('routes consumer validation failures through the same recovery callback', () => {
  vi.stubGlobal('EventSource', Source)
  const scope = openEventStreamScope()!, invalid = vi.fn()
  const failure = new Error('Chat stream target changed')
  try {
    connectChatStream(scope, '/api/chat/events', { schema: z.object({ cursor: z.string() }), events: ['changed'],
      receive: () => { throw failure }, invalid, handlers: {} })
    Source.current.dispatchEvent(new MessageEvent('changed', { data: '{"cursor":"first"}' }))
    expect(invalid).toHaveBeenCalledExactlyOnceWith(failure)
  } finally { scope.close() }
})

it('distinguishes duplicates, stale IDs and gaps independently for each connection and snapshot', () => {
  const sequence = createChatStreamSequence(), other = createChatStreamSequence()
  expect(sequence.remember(5)).toBe('next')
  sequence.advance(5)
  expect(sequence.remember(5)).toBe('duplicate')
  expect(sequence.remember(4)).toBe('stale')
  expect(sequence.remember(8)).toBe('gap')
  sequence.advance(8)
  expect(sequence.remember(9)).toBe('next')
  expect(other.remember(0)).toBe('next')
  sequence.reset()
  expect(sequence.remember(0)).toBe('next')
})

it('bounds duplicate memory while retaining the high-water fence for evicted IDs', () => {
  const sequence = createChatStreamSequence()
  for (let id = 0; id < 257; id++) {
    expect(sequence.remember(id)).toBe('next')
    sequence.advance(id)
  }
  expect(sequence.remember(256)).toBe('duplicate')
  expect(sequence.remember(0)).toBe('stale')
})

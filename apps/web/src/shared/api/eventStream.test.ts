import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { openEventStreamScope } from './eventStream'
import { beginSessionChange, finishSessionChange } from './sessionBoundary'

class FakeSource extends EventTarget {
  static instances: FakeSource[] = []
  close = vi.fn()
  constructor(readonly url: string) { super(); FakeSource.instances.push(this) }
}
beforeEach(() => { FakeSource.instances = []; vi.stubGlobal('EventSource', FakeSource) })
afterEach(() => { vi.unstubAllGlobals() })

it('runs handlers only for the active connection of a live scope', () => {
  const scope = openEventStreamScope()!
  const changed = vi.fn()
  const first = scope.connect('/api/first/events', { changed })
  const [source] = FakeSource.instances
  source!.dispatchEvent(new Event('changed'))
  expect(changed).toHaveBeenCalledOnce()
  first.close()
  source!.dispatchEvent(new Event('changed'))
  expect(changed).toHaveBeenCalledOnce()
  expect(source!.close).toHaveBeenCalledOnce()
  expect(first.active).toBe(false)
  scope.close()
})

it('closes its connections and runs cleanups when the caller aborts', () => {
  const controller = new AbortController(), cleanup = vi.fn()
  const scope = openEventStreamScope(controller.signal)!
  const connection = scope.connect('/api/stream/events', { changed: vi.fn() })
  scope.onClose(cleanup)
  controller.abort()
  expect(scope.valid()).toBe(false)
  expect(connection.active).toBe(false)
  expect(FakeSource.instances[0]!.close).toHaveBeenCalledOnce()
  expect(cleanup).toHaveBeenCalledOnce()
})

it('ends with the document session and starts nothing while the session is switching', () => {
  const scope = openEventStreamScope()!
  const changed = vi.fn()
  scope.connect('/api/stream/events', { changed })
  beginSessionChange()
  try {
    FakeSource.instances[0]!.dispatchEvent(new Event('changed'))
    expect(changed).not.toHaveBeenCalled()
    expect(scope.valid()).toBe(false)
    expect(openEventStreamScope()).toBeUndefined()
  } finally { finishSessionChange() }
})

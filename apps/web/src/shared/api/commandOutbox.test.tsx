import { act, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { installBrowserLocks } from '../../test/browserLocks'
import { createOutboxView, readStoredCommand, withCommandLock, writeStoredCommand } from './commandOutbox'
import { beginSessionChange, finishSessionChange } from './sessionBoundary'

let restoreLocks: () => void
beforeEach(() => { localStorage.clear(); restoreLocks = installBrowserLocks() })
afterEach(() => { restoreLocks(); vi.restoreAllMocks() })

it('writes a command, reads it back unchanged and removes it', () => {
  writeStoredCommand('outbox:start', '{"commandId":"one"}', 'Unavailable.')
  expect(readStoredCommand('outbox:start', 'Unavailable.')).toBe('{"commandId":"one"}')
  writeStoredCommand('outbox:start', undefined, 'Unavailable.')
  expect(readStoredCommand('outbox:start', 'Unavailable.')).toBeUndefined()
  expect(localStorage.getItem('outbox:start')).toBeNull()
})

it('refuses a write that does not read back, and storage that cannot be read', () => {
  vi.spyOn(Storage.prototype, 'getItem').mockReturnValue('{"commandId":"other"}')
  expect(() => writeStoredCommand('outbox:start', '{"commandId":"one"}', 'Unavailable.')).toThrow('Unavailable.')
  vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => { throw new DOMException('denied', 'SecurityError') })
  expect(() => readStoredCommand('outbox:start', 'Unavailable.')).toThrow('Unavailable.')
})

it('serializes work under one lock name and refuses to start while the session is switching', async () => {
  const order: string[] = []
  await Promise.all([
    withCommandLock('outbox:start', async () => { order.push('first'); await Promise.resolve(); order.push('first done') }, { unavailable: 'No locks.' }),
    withCommandLock('outbox:start', () => { order.push('second') }, { unavailable: 'No locks.' }),
  ])
  expect(order).toEqual(['first', 'first done', 'second'])
  beginSessionChange()
  try {
    await expect(withCommandLock('outbox:start', () => 'sent', { unavailable: 'No locks.' })).rejects.toHaveProperty('name', 'AbortError')
  } finally { finishSessionChange() }
})

it('fails closed without Web Locks', async () => {
  restoreLocks()
  await expect(withCommandLock('outbox:start', () => 'sent', { unavailable: 'No locks.' })).rejects.toThrow('No locks.')
  restoreLocks = installBrowserLocks()
})

it('shows the stored command and follows changes from other tabs', () => {
  const view = createOutboxView<{ command?: string; error?: string }>()
  const read = () => ({ command: readStoredCommand('outbox:memory', 'Unavailable.') })
  const failed = (error: unknown) => ({ error: (error as Error).message })
  localStorage.setItem('outbox:memory', 'first')
  const { result } = renderHook(() => view.useRecord('outbox:memory', read, failed))
  expect(result.current).toEqual({ command: 'first' })
  act(() => {
    localStorage.setItem('outbox:memory', 'second')
    window.dispatchEvent(new StorageEvent('storage', { key: 'outbox:memory' }))
  })
  expect(result.current).toEqual({ command: 'second' })
  act(() => view.publish('outbox:memory', {}))
  expect(result.current).toEqual({})
})

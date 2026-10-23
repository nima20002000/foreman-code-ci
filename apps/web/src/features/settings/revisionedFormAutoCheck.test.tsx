import { act, cleanup, renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { clearRevisionedFormPersistence, useRevisionedForm } from './revisionedForm'

interface Value { name: string }
const initial = { value: { name: 'original' }, revision: 1 }
const restarting = () => Object.assign(new Error('Failed to fetch'), { code: 'NETWORK_ERROR' })

beforeEach(() => { vi.useFakeTimers(); clearRevisionedFormPersistence() })
afterEach(() => { cleanup(); clearRevisionedFormPersistence(); vi.useRealTimers() })

describe('a save whose answer was lost during an app restart', () => {
  it('resends the original command by itself until the app answers, without asking for Retry', async () => {
    const form = renderHook(() => useRevisionedForm<Value>(initial, 'auto-check'))
    act(() => form.result.current.setDraft({ name: 'sent' }))
    let up = false
    const perform = vi.fn(async (request: { value: Value; expectedRevision: number; commandId: string }) => {
      if (!up) throw restarting()
      return { value: request.value, revision: 2 }
    })
    await act(async () => { await form.result.current.save(perform) })
    expect(form.result.current.uncertain).toBe(true)
    expect(form.result.current.checking).toBe(true)

    await act(async () => { await vi.advanceTimersByTimeAsync(1_000) })
    expect(perform).toHaveBeenCalledTimes(2)
    expect(form.result.current.isSaving).toBe(false)
    expect(form.result.current.checking).toBe(true)

    up = true
    await act(async () => { await vi.advanceTimersByTimeAsync(2_000) })
    expect(perform).toHaveBeenCalledTimes(3)
    expect(perform.mock.calls.map(([request]) => request)).toEqual(Array(3).fill(perform.mock.calls[0]![0]))
    expect(form.result.current.uncertain).toBe(false)
    expect(form.result.current.baseRevision).toBe(2)
    expect(form.result.current.savedRevision).toBe(2)
  })

  it('stops resending after ten minutes and leaves the manual Retry', async () => {
    const form = renderHook(() => useRevisionedForm<Value>(initial, 'auto-check-deadline'))
    act(() => form.result.current.setDraft({ name: 'sent' }))
    const perform = vi.fn(async () => { throw restarting() })
    await act(async () => { await form.result.current.save(perform) })
    await act(async () => { await vi.advanceTimersByTimeAsync(11 * 60_000) })
    const calls = perform.mock.calls.length
    expect(form.result.current.uncertain).toBe(true)
    expect(form.result.current.checking).toBe(false)
    await act(async () => { await vi.advanceTimersByTimeAsync(60_000) })
    expect(perform).toHaveBeenCalledTimes(calls)
  })
})

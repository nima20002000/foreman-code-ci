import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { AgentBrowserPanel } from './AgentBrowserPanel'
import { browserFilesFake, browserPortFake, browserRead, deferred, frame, subject } from './testFixtures'
import type { BrowserSessionRead } from './types'

function mount(fake: ReturnType<typeof browserPortFake>) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><AgentBrowserPanel visible
    selection={{ authBoundary: 'login', visitKey: 'visit', subject, sessionId: 'session', tabId: 'tab', enabled: true, historical: false }}
    port={fake.port} files={browserFilesFake()} computerName="Main" profileName="Work" readOnly={false}
    onOpenSettings={vi.fn()} onSelectSession={vi.fn()} onSelectTab={vi.fn()} onCleanupError={vi.fn()} />
  </QueryClientProvider>)
}

it('stops automatic reconnect after forty attempts even when recovery succeeds but the view remains unavailable', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    const read = browserRead()
    read.session.state = 'recovering'
    const fake = browserPortFake(read)
    vi.mocked(fake.port.openView).mockRejectedValue(new Error('The owned browser generation is unavailable.'))
    const view = mount(fake)
    await waitFor(() => expect(fake.port.openView).toHaveBeenCalledTimes(1))
    for (let tick = 0; tick < 45; tick++) {
      await act(async () => { await vi.advanceTimersByTimeAsync(3_050) })
    }
    expect(fake.port.reconnect).toHaveBeenCalledTimes(40)
    fireEvent.click(screen.getByRole('button', { name: 'Reconnect', exact: true }))
    await act(async () => { await vi.advanceTimersByTimeAsync(50) })
    expect(fake.port.reconnect).toHaveBeenCalledTimes(41)
    view.unmount()
  } finally { vi.useRealTimers() }
})

it('settles the original browser command before automatically reconnecting a lost view', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    const fake = browserPortFake(), response = deferred<BrowserSessionRead>()
    vi.mocked(fake.port.createTab).mockReturnValueOnce(response.promise)
    const view = mount(fake)
    await waitFor(() => expect(fake.port.openView).toHaveBeenCalledTimes(1))
    act(() => fake.observer!.frame(frame()))
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    await waitFor(() => expect(fake.port.createTab).toHaveBeenCalledTimes(1))
    const original = vi.mocked(fake.port.createTab).mock.calls[0]!
    act(() => fake.observer!.disconnected(new Error('Browser view disconnected')))
    await act(async () => { await vi.advanceTimersByTimeAsync(3_050) })
    expect(fake.port.reconnect).not.toHaveBeenCalled()
    await act(async () => { response.reject(new TypeError('Failed to fetch')) })
    expect(await screen.findByRole('button', { name: 'Check original browser action' })).toBeVisible()
    await act(async () => { await vi.advanceTimersByTimeAsync(3_050) })
    expect(fake.port.reconnect).not.toHaveBeenCalled()
    fireEvent.click(screen.getByRole('button', { name: 'Check original browser action' }))
    await waitFor(() => expect(fake.port.createTab).toHaveBeenCalledTimes(2))
    expect(vi.mocked(fake.port.createTab).mock.calls[1]).toEqual(original)
    await act(async () => { await vi.advanceTimersByTimeAsync(3_050) })
    expect(fake.port.reconnect).toHaveBeenCalledTimes(1)
    view.unmount()
  } finally { vi.useRealTimers() }
})

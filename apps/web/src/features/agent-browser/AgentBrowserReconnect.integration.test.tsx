import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { expect, it, vi } from 'vitest'
import { AgentBrowserPanel } from './AgentBrowserPanel'
import { browserFilesFake, browserPortFake, browserRead, subject } from './testFixtures'

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

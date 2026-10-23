import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, fireEvent, render, screen, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { AgentBrowserPanel } from './AgentBrowserPanel'
import { browserFilesFake, browserPortFake, browserRead, deferred, frame, subject } from './testFixtures'
import type { BrowserSessionRead } from './types'
import type { BrowserFileLabel } from './transferTypes'

beforeEach(() => { vi.stubGlobal('URL', Object.assign(URL, { createObjectURL: vi.fn(() => 'blob:fixture'), revokeObjectURL: vi.fn() })) })
afterEach(() => { vi.unstubAllGlobals() })

function mount(fake: ReturnType<typeof browserPortFake>, files = browserFilesFake()) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  return render(<QueryClientProvider client={client}><AgentBrowserPanel visible
    selection={{ authBoundary: 'login', visitKey: 'visit', subject, sessionId: 'session', tabId: 'tab', enabled: true, historical: false }}
    port={fake.port} files={files} computerName="Main" profileName="Work" readOnly={false}
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
    const fake = browserPortFake(), response = deferred<BrowserSessionRead & { createdTabId: string }>()
    vi.mocked(fake.port.createTab).mockReturnValueOnce(response.promise)
    const view = mount(fake)
    await waitFor(() => expect(fake.port.openView).toHaveBeenCalledTimes(1))
    act(() => fake.observer!.frame(frame()))
    fireEvent.click(screen.getByRole('button', { name: 'New tab' }))
    await waitFor(() => expect(fake.port.createTab).toHaveBeenCalledTimes(1))
    expect(screen.getByRole('button', { name: 'New tab' })).toBeDisabled()
    const original = vi.mocked(fake.port.createTab).mock.calls[0]!
    console.log('command before loss', { views: vi.mocked(fake.port.openView).mock.calls.map(call => [call[0].id, call[1].tabId, call[2]]),
      addressDisabled: screen.getByRole('textbox', { name: 'Website address' }).hasAttribute('disabled'), reconnects: vi.mocked(fake.port.reconnect).mock.calls })
    act(() => fake.observer!.disconnected(new Error('Browser view disconnected')))
    await act(async () => { await vi.advanceTimersByTimeAsync(3_050) })
    expect(fake.port.reconnect).not.toHaveBeenCalled()
    console.log('command after loss', { views: vi.mocked(fake.port.openView).mock.calls.map(call => [call[0].id, call[1].tabId, call[2]]),
      addressDisabled: screen.getByRole('textbox', { name: 'Website address' }).hasAttribute('disabled'), reconnects: vi.mocked(fake.port.reconnect).mock.calls,
      createCalls: vi.mocked(fake.port.createTab).mock.calls, releases: vi.mocked(fake.port.release).mock.calls })
    expect(fake.port.openView).toHaveBeenCalledTimes(1)
    expect(screen.getByRole('button', { name: 'Reconnect', exact: true })).toBeDisabled()
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

it('keeps an in-flight upload alive across automatic view recovery and attaches it using the recovered view', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    const read = browserRead(), files = browserFilesFake(), finishing = deferred<BrowserFileLabel>()
    read.uploadChooser = { tabId: 'tab', selector: '#upload' }
    const fake = browserPortFake(read)
    const upload: BrowserFileLabel = { id: 'upload', name: 'empty.txt', mimeType: 'text/plain', byteLength: 0,
      receivedBytes: 0, state: 'uploading', purpose: 'upload' }
    vi.mocked(files.begin).mockResolvedValue(upload)
    vi.mocked(files.finish).mockReturnValue(finishing.promise)
    const view = mount(fake, files)
    await waitFor(() => expect(fake.port.openView).toHaveBeenCalledTimes(1))
    act(() => fake.observer!.frame(frame()))
    fireEvent.change(screen.getByLabelText('Upload file'), { target: { files: [new File([], 'empty.txt', { type: 'text/plain' })] } })
    await waitFor(() => expect(files.finish).toHaveBeenCalledTimes(1))
    act(() => fake.observer!.disconnected(new Error('Browser view disconnected')))
    await act(async () => { await vi.advanceTimersByTimeAsync(3_050) })
    await waitFor(() => expect(fake.port.openView).toHaveBeenCalledTimes(2))
    expect(files.cancel).not.toHaveBeenCalled()
    act(() => fake.observer!.frame(frame()))
    await act(async () => { finishing.resolve({ ...upload, state: 'ready' }) })
    await waitFor(() => expect(files.attach).toHaveBeenCalledWith(expect.objectContaining({ id: 'session' }),
      expect.objectContaining({ tabId: 'tab' }), 'upload', '#upload', expect.any(String),
      { viewerId: expect.any(String), epoch: 1 }))
    expect(files.cancel).not.toHaveBeenCalled()
    view.unmount()
  } finally { vi.useRealTimers() }
})

it('finishes saving an in-flight download after automatic view recovery without aborting its request', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  try {
    const read = browserRead(), files = browserFilesFake(), downloading = deferred<Uint8Array>()
    read.files = [{ id: 'download', name: 'report.txt', mimeType: 'text/plain', byteLength: 3,
      receivedBytes: 3, state: 'ready', purpose: 'download' }]
    const fake = browserPortFake(read)
    vi.mocked(files.read).mockReturnValue(downloading.promise)
    const save = vi.spyOn(HTMLAnchorElement.prototype, 'click').mockImplementation(() => undefined)
    const view = mount(fake, files)
    await waitFor(() => expect(fake.port.openView).toHaveBeenCalledTimes(1))
    act(() => fake.observer!.frame(frame()))
    fireEvent.click(screen.getByRole('button', { name: 'Save file' }))
    await waitFor(() => expect(files.read).toHaveBeenCalledTimes(1))
    const signal = vi.mocked(files.read).mock.calls[0]![4]
    act(() => fake.observer!.disconnected(new Error('Browser view disconnected')))
    await act(async () => { await vi.advanceTimersByTimeAsync(3_050) })
    await waitFor(() => expect(fake.port.openView).toHaveBeenCalledTimes(2))
    expect(signal.aborted).toBe(false)
    await act(async () => { downloading.resolve(new Uint8Array([1, 2, 3])) })
    await waitFor(() => expect(save).toHaveBeenCalledTimes(1))
    expect(save.mock.instances[0]).toHaveProperty('download', 'report.txt')
    view.unmount()
  } finally { vi.useRealTimers() }
})

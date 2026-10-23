import { expect, it, vi } from 'vitest'
import { createBrowserUiClient, type BrowserCommandCodecs } from './client'
import { browserRead, deferred } from './testFixtures'

class RetirementSocket {
  static last: RetirementSocket
  onopen: (() => void) | null = null
  onmessage: ((event: MessageEvent) => void) | null = null
  onerror: (() => void) | null = null
  onclose: (() => void) | null = null
  binaryType = 'arraybuffer'
  send = vi.fn()
  close = vi.fn()
  constructor() { RetirementSocket.last = this }
}

it.each(['close', 'abort'] as const)('retires the durable view before closing its media socket during %s', async retirement => {
  const deleting = deferred<void>(), deleted = deferred<void>()
  const unused = { encode: (): never => { throw new Error('Unexpected command') },
    decode: async (): Promise<never> => { throw new Error('Unexpected command') } }
  const commands: BrowserCommandCodecs = { prepare: unused, listSessions: unused, listSetupSessions: unused,
    readSession: unused, reconnect: unused, acquire: unused, release: unused, pause: unused, input: unused,
    releasePressed: unused, selectTab: unused, createTab: unused, closeTab: unused, navigate: unused,
    respondDialog: unused, openLocalBrowser: unused, closeSession: unused }
  const client = createBrowserUiClient({ origin: 'http://localhost', commands,
    socket: RetirementSocket as unknown as typeof WebSocket,
    fetch: async (_url, request) => {
      if (request?.method === 'DELETE') { deleting.resolve(); await deleted.promise }
      return new Response('{}')
    },
    error: async () => ({ message: 'Rejected' }),
    views: { open: { encode: () => ({}), decode: async () => ({ viewId: 'view' }) }, read: unused,
      close: { encode: () => ({}), decode: async () => undefined },
      media: { hello: () => '{}', decode: (): never => { throw new Error('Unexpected media') } } } })
  const read = browserRead(), abort = new AbortController()
  const observer = { frame: vi.fn(), control: vi.fn(), disconnected: vi.fn() }
  const view = await client.openView(read.session, read.tabs[0]!, 'viewer', observer, abort.signal)
  const socket = RetirementSocket.last
  socket.onopen!()
  try {
    const closing = retirement === 'close' ? view.close() : (abort.abort(), undefined)
    await deleting.promise
    expect(socket.close).not.toHaveBeenCalled()
    deleted.resolve()
    await closing
    await vi.waitFor(() => expect(socket.close).toHaveBeenCalledTimes(1))
    expect(observer.disconnected).not.toHaveBeenCalled()
  } finally {
    deleted.resolve()
    await view.close()
  }
})

import { afterEach, describe, expect, it, vi } from 'vitest'
import { WebSocketServer, type WebSocket } from 'ws'
import type { AddressInfo } from 'node:net'
import { BrowserCdpConnection } from './cdp.js'
import { ManagedBrowserNativeDriver, type BrowserNativeDriverOptions } from './nativeDriver.js'

const servers: WebSocketServer[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => new Promise(done => { for (const c of server.clients) c.terminate(); server.close(done) }))) })

async function healthyBrowser(options: Partial<BrowserNativeDriverOptions>) {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 }); servers.push(server); await new Promise(done => server.once('listening', done))
  const peer = new Promise<WebSocket>(resolve => server.once('connection', resolve))
  const connection = await BrowserCdpConnection.connect(`ws://127.0.0.1:${(server.address() as AddressInfo).port}`)
  const browser = await peer
  const onDisconnected = vi.fn(), reportFailure = vi.fn()
  const driver = new ManagedBrowserNativeDriver({ runtime: {} as never, actionDirectory: '/nonexistent', profileDirectory: async () => ({ directory: '/nonexistent', generation: 1 }),
    allocateGeneration: async () => 1, onOrigin: async () => undefined, onDisconnected, reportFailure, downloadDirectory: () => '/nonexistent/downloads', ...options } as BrowserNativeDriverOptions)
  const profile = { generation: 1, process: null, identity: { directory: '/nonexistent', generation: 1 }, connection, headless: true, pendingPopups: new Set(),
    tabs: new Map([['tab', { id: 'tab', sessionId: 'session', title: '', url: '', keys: new Map(), buttons: new Set(), pointer: { x: 0, y: 0 }, dialog: null, frameIds: new Set(['frame']), chooser: null }]]) }
  ;(driver as unknown as { profiles: Map<string, unknown> }).profiles.set('profile', profile)
  connection.onEvent(event => (driver as unknown as { event(id: string, p: unknown, e: unknown): void }).event('profile', profile, event))
  const emit = (value: object) => browser.send(JSON.stringify(value))
  const settle = () => new Promise(done => setTimeout(done, 50))
  return { onDisconnected, reportFailure, emit, settle }
}

describe('native driver bookkeeping failures', () => {
  it('does not report a healthy browser as disconnected when origin bookkeeping fails', async () => {
    const failure = new Error('profile.json write failed')
    const { onDisconnected, reportFailure, emit, settle } = await healthyBrowser({ onOrigin: async () => { throw failure } })
    emit({ method: 'Page.frameNavigated', sessionId: 'session', params: { frame: { id: 'frame', url: 'https://example.test/page' } } })
    await settle()
    expect(onDisconnected).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledWith(failure)
  })

  it('does not report a healthy browser as disconnected when download bookkeeping fails', async () => {
    const failure = new Error('download size mismatch')
    const { onDisconnected, reportFailure, emit, settle } = await healthyBrowser({ onDownload: async () => { throw failure } })
    emit({ method: 'Browser.downloadWillBegin', params: { guid: 'abc', frameId: 'frame', suggestedFilename: 'a.txt' } })
    await settle()
    expect(onDisconnected).not.toHaveBeenCalled()
    expect(reportFailure).toHaveBeenCalledWith(failure)
  })
})

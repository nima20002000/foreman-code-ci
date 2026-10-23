import { once } from 'node:events'
import { serialize, deserialize } from 'node:v8'
import { WebSocket, WebSocketServer } from 'ws'
import { expect, it, vi } from 'vitest'
import { attachBrowserHostMedia, BrowserPairedMediaHub, type BrowserHostMediaCodec, type BrowserHostMediaMessage } from './pairedMedia.js'
import type { BrowserPairingAuthority } from '../browser-profiles/keys.js'
import { held, runtimeRecoveryFixture } from './recovery.test-support.js'

it('keeps sibling views connected when frame bursts arrive during a delayed installation check', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('Expected loopback server address')
  const connection = once(server, 'connection')
  const remote = new WebSocket(`ws://127.0.0.1:${address.port}`)
  await once(remote, 'open')
  const [socket] = await connection as [WebSocket]
  const codec: BrowserHostMediaCodec = {
    encode: message => message.kind === 'frame' ? serialize(message) : JSON.stringify(message),
    decode: value => typeof value === 'string' ? JSON.parse(value) as BrowserHostMediaMessage : deserialize(value) as BrowserHostMediaMessage,
  }
  const binding = { computerId: 'worker', installationId: 'installation', connectionId: 'connection' }
  const gate = held<void>(), entered = held<void>()
  let blocked = false
  const pairing: BrowserPairingAuthority = { current: async () => binding, wrappingKey: async () => Buffer.alloc(32),
    assertInstallation: async () => undefined, assertCurrent: async () => {
      if (blocked) { entered.resolve(); await gate.promise }
    } }
  const failures = vi.fn(), ids = new Map<string, string>()
  const hub = new BrowserPairedMediaHub(pairing, codec, (principal: string) => principal, async () => undefined, failures)
  const send = (message: BrowserHostMediaMessage) => remote.send(codec.encode(message))
  try {
    await hub.attach(binding, socket)
    remote.on('message', bytes => {
      const message = codec.decode(bytes.toString())
      if (message.kind !== 'open') return
      ids.set(message.sessionId, message.id)
      send({ kind: 'opened', id: message.id, view: { id: message.viewId, sessionId: message.sessionId, tabId: 'tab', browserGeneration: 1 } })
      send({ kind: 'control', id: message.id, control: { sessionId: message.sessionId, epoch: 1,
        state: 'user', controllingViewerId: 'viewer', reason: null } })
      send({ kind: 'snapshot_end', id: message.id })
    })
    const source = hub.source(binding)
    const first = await source.open('owner', 'first', 'view-first', () => undefined)
    const sibling = await source.open('owner', 'sibling', 'view-sibling', () => undefined)
    const frame = (sessionId: string, sequence: number): BrowserHostMediaMessage => ({ kind: 'frame', id: ids.get(sessionId)!, offset: 0,
      bytes: Buffer.alloc(180_000, sequence), frame: { sessionId, tabId: 'tab', browserGeneration: 1, sequence, byteLength: 180_000,
        mimeType: 'image/jpeg', width: 100, height: 100, viewportOffsetTop: 0, capturedAt: '2026-01-01T00:00:00.000Z' } })
    blocked = true
    send(frame('first', 1))
    await entered.promise
    for (let sequence = 2; sequence <= 8; sequence++) send(frame('first', sequence))
    send(frame('sibling', 1))
    const receivedBurst = Promise.race([
      once(remote, 'pong').then(() => 'received'),
      once(remote, 'close').then(() => 'disconnected'),
    ])
    remote.ping()
    expect(await receivedBurst).toBe('received')
    blocked = false
    gate.resolve()
    await vi.waitFor(async () => expect((await sibling.read(0)).frame?.sequence).toBe(1))
    expect(socket.readyState).toBe(WebSocket.OPEN)
    expect((await first.read(0)).control.controllingViewerId).toBe('viewer')
    send(frame('first', 9))
    await vi.waitFor(async () => expect((await first.read(0)).frame?.sequence).toBe(9))
    expect(failures).not.toHaveBeenCalled()
    await first.close(false)
    await sibling.close(false)
  } finally {
    blocked = false
    gate.resolve()
    socket.terminate()
    remote.terminate()
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
  }
})

it('rejects an expired view without disconnecting a sibling stream or pausing its controller', async () => {
  const f = await runtimeRecoveryFixture()
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('Expected loopback server address')
  const connection = once(server, 'connection'), remote = new WebSocket(`ws://127.0.0.1:${address.port}`)
  await once(remote, 'open')
  const [socket] = await connection as [WebSocket]
  const codec: BrowserHostMediaCodec = {
    encode: message => message.kind === 'frame' ? serialize(message) : JSON.stringify(message),
    decode: value => typeof value === 'string' ? JSON.parse(value) as BrowserHostMediaMessage : deserialize(value) as BrowserHostMediaMessage,
  }
  const binding = { computerId: 'worker', installationId: 'installation', connectionId: 'connection' }
  const pairing: BrowserPairingAuthority = { current: async () => binding, wrappingKey: async () => Buffer.alloc(32),
    assertInstallation: async () => undefined, assertCurrent: async () => undefined }
  const hub = new BrowserPairedMediaHub(pairing, codec, (principal: string) => principal, async () => undefined, f.reportFailure)
  try {
    const session = await f.prepare()
    const target = { sessionId: session.id, tabId: session.selectedTabId!, browserGeneration: session.browserGeneration,
      ownerId: 'owner', viewerId: 'viewer' }
    const live = await f.media.open({ ...target, commandId: 'live' })
    const expired = await f.media.open({ ...target, commandId: 'expired' })
    await f.media.close(expired.id, 'owner')
    const control = await f.broker.acquire({ sessionId: session.id, browserGeneration: session.browserGeneration,
      viewerId: 'viewer', commandId: 'take' })
    await hub.attach(binding, socket)
    await attachBrowserHostMedia(remote, binding, pairing, codec, f.media, f.broker, f.reportFailure)
    const source = hub.source(binding), sibling = await source.open('owner', session.id, live.id, () => undefined)
    await expect(source.open('owner', session.id, expired.id, () => undefined)).rejects.toMatchObject({ code: 'BROWSER_VIEW_CLOSED' })
    expect((await sibling.read(0)).control).toEqual(control)
    const frame = { data: Buffer.from('frame after rejected open'), mimeType: 'image/png' as const, width: 100, height: 80,
      viewportOffsetTop: 0, capturedAt: '2026-10-23T00:00:00.000Z' }
    vi.mocked(f.driver.capture).mock.calls[0]![3](frame)
    await vi.waitFor(async () => expect((await sibling.read(0)).frame?.data).toEqual(new Uint8Array(frame.data)))
    expect(f.broker.read(session.id).control).toEqual(control)
    expect(socket.readyState).toBe(WebSocket.OPEN)
    await sibling.close(false)
  } finally {
    const closed = socket.readyState === WebSocket.CLOSED ? Promise.resolve() : once(socket, 'close')
    socket.terminate(); remote.terminate()
    await closed
    await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve()))
    await f.cleanup()
  }
})

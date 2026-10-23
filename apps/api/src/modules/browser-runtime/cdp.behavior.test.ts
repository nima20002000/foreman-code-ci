import { once } from 'node:events'
import { WebSocketServer, type WebSocket } from 'ws'
import { it } from 'vitest'
import { BrowserCdpConnection } from './cdp.js'

it('closes its socket when the browser sends a malformed frame', async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 })
  await once(server, 'listening')
  const address = server.address()
  if (typeof address === 'string' || !address) throw new Error('Expected loopback server address')
  const accepted = once(server, 'connection') as Promise<[WebSocket]>
  const connection = await BrowserCdpConnection.connect(`ws://127.0.0.1:${address.port}`)
  try {
    const [peer] = await accepted
    const closed = once(peer, 'close')
    const disconnected = new Promise<void>(resolve => connection.onDisconnected(resolve))
    peer.send('not json')
    await disconnected
    await Promise.race([closed, new Promise((_resolve, reject) => setTimeout(() => reject(new Error('The CDP socket stayed open')), 2000))])
  } finally {
    connection.close()
    await new Promise(resolve => server.close(resolve))
  }
})

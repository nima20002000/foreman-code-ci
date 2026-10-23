import { createServer, type Server, type Socket } from 'node:net'
import { afterEach, describe, expect, it, vi } from 'vitest'
import { isDatabasePoolTimeout } from './databaseRetry.js'
import { withDedicatedClient } from './pool.js'

let server: Server | undefined
const sockets = new Set<Socket>()

afterEach(async () => {
  for (const socket of sockets) socket.destroy()
  sockets.clear()
  await new Promise<void>(resolve => { if (server) server.close(() => resolve()); else resolve() })
  server = undefined
})

/** Accepts TCP connections and never answers, like a database too busy to finish authentication. */
async function silentDatabase(): Promise<number> {
  server = createServer(socket => { sockets.add(socket) })
  await new Promise<void>(resolve => server!.listen(0, '127.0.0.1', () => resolve()))
  const address = server.address()
  if (!address || typeof address === 'string') throw new Error('The silent database has no port.')
  return address.port
}

describe('dedicated database connections', () => {
  it('report a connect timeout as a connection timeout that callers retry', async () => {
    const port = await silentDatabase()
    const work = vi.fn()
    const failure = await withDedicatedClient({ host: '127.0.0.1', port, user: 'foreman', database: 'foreman',
      connectionTimeoutMillis: 50 }, 'dedicated-timeout-test', work).catch((error: unknown) => error)
    expect(work).not.toHaveBeenCalled()
    expect(failure).toBeInstanceOf(Error)
    expect(isDatabasePoolTimeout(failure)).toBe(true)
  })
})

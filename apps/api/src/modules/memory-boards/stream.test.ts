import { get } from 'node:http'
import Fastify from 'fastify'
import { describe, expect, it } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { MemoryBoardService } from './service.js'
import { streamMemoryBoard } from './stream.js'

function deferred<T>() {
  let resolve!: (value: T | PromiseLike<T>) => void
  const promise = new Promise<T>(accept => { resolve = accept })
  return { promise, resolve }
}

describe('Memory board HTTP stream lifetime', () => {
  it('releases a subscription that finishes registering after its HTTP client disconnects', async () => {
    const entering = deferred<void>(), registration = deferred<() => void>()
    const closed = deferred<void>(), completed = deferred<void>()
    let subscribers = 0
    const service: Pick<MemoryBoardService, 'changes' | 'listen'> = {
      async changes() {
        return { items: [], nextCursor: null, hasMore: false, revision: 0, watermark: 0, resetRequired: false }
      },
      async listen() {
        entering.resolve()
        return registration.promise
      },
    }
    const principal: ManagementPrincipal = { id: 'stream-reader', name: 'Reader', audience: 'operator',
      grants: [], expiresAt: '9999-12-31T23:59:59.999Z', revokedAt: null }
    const app = Fastify({ logger: false })
    app.get('/events', async (request, reply) => {
      reply.raw.once('close', () => closed.resolve())
      try { await streamMemoryBoard(request, reply, service, principal, 'board') }
      finally { completed.resolve() }
    })
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    const request = get(new URL('/events', address))
    // The expected local abort is observed explicitly instead of becoming an
    // unhandled ClientRequest error while the server is registering its listener.
    const clientError = deferred<Error>()
    request.once('error', error => clientError.resolve(error))
    try {
      await entering.promise
      request.destroy(new Error('Close the visible board'))
      await closed.promise
      subscribers += 1
      registration.resolve(() => { subscribers -= 1 })
      await completed.promise
      expect((await clientError.promise).message).toBe('Close the visible board')
      expect(subscribers).toBe(0)
    } finally {
      request.destroy()
      registration.resolve(() => { subscribers = 0 })
      await app.close()
    }
  })
})

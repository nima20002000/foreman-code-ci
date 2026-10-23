import Fastify, { type FastifyInstance } from 'fastify'
import { afterEach, expect, it } from 'vitest'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '@foreman-code/contracts/server-kit'
import { HttpCiClient, type CiTicketClient } from '../src/client.js'
import { registerHostCiRoutes } from '../src/http.js'

const caller = { id: 'principal-1' } as ManagementPrincipal
const servers: FastifyInstance[] = []
afterEach(async () => { await Promise.all(servers.splice(0).map(server => server.close())) })

/** The CI routes served by a real Fastify app, reached by the HTTP client over a loopback socket. */
async function connect(service: Partial<CiTicketClient>) {
  const app = Fastify()
  servers.push(app)
  app.setErrorHandler((error, _request, reply) => {
    const failure = error instanceof DomainError ? error : new DomainError('INTERNAL_ERROR', String(error), 500)
    return reply.code(failure.status).send({ error: { code: failure.code, message: failure.message,
      ...(failure.details ? { details: failure.details } : {}) } })
  })
  const seen: string[] = []
  registerHostCiRoutes(app, { services: { ci: service as CiTicketClient },
    principal: request => { seen.push(String(request.headers.authorization)); return caller } })
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
  const client = new HttpCiClient({ baseUrl, headers: () => ({ authorization: 'Bearer caller-token' }) })
  return { client, seen }
}

it('starts a ticket through the CI route and returns the ticket the service answered', async () => {
  let received: unknown
  const { client, seen } = await connect({
    run: async (_caller, input) => { received = input; return { ticketId: 'ticket-7' } },
  })
  const result = await client.run(caller, { workspaceId: 'workspace-1', suite: 'unit', scope: 'full' })
  expect(result).toEqual({ ticketId: 'ticket-7' })
  expect(received).toMatchObject({ workspaceId: 'workspace-1', suite: 'unit', scope: 'full' })
  expect(seen).toEqual(['Bearer caller-token'])
})

it('carries a ticket read’s wait options and test filter through the route and keeps the service’s failure code', async () => {
  let received: unknown
  const { client } = await connect({
    get: async (_caller, input) => {
      received = input
      throw new DomainError('CI_RUN_NOT_FOUND', 'No such CI run in this workspace.', 404, { recentTickets: [] })
    },
  })
  const failure = await client.get(caller, { workspaceId: 'workspace-1', ticketId: 'ticket-7', waitUntil: 'group-terminal',
    waitSeconds: 30, logTail: false, testStatus: ['failed', 'skipped'] }).catch(error => error)
  expect(failure).toBeInstanceOf(DomainError)
  expect(failure).toMatchObject({ code: 'CI_RUN_NOT_FOUND', status: 404, details: { recentTickets: [] } })
  expect(received).toEqual({ workspaceId: 'workspace-1', ticketId: 'ticket-7', waitUntil: 'group-terminal',
    waitSeconds: 30, logTail: false, testStatus: ['failed', 'skipped'] })
})

it('passes a cancellation’s command identity and requires a workspace', async () => {
  let received: unknown
  const { client } = await connect({
    cancel: async (_caller, input) => { received = input; throw new DomainError('CI_CANCEL_REFUSED', 'Refused.', 409) },
  })
  await expect(client.cancel(caller, { workspaceId: 'workspace-1', ticketId: 'ticket-7', commandId: 'command-1' }))
    .rejects.toMatchObject({ code: 'CI_CANCEL_REFUSED', status: 409 })
  expect(received).toEqual({ workspaceId: 'workspace-1', ticketId: 'ticket-7', commandId: 'command-1' })
  await expect(client.cancel(caller, { ticketId: 'ticket-7' })).rejects.toMatchObject({ code: 'CI_WORKSPACE_REQUIRED' })
})

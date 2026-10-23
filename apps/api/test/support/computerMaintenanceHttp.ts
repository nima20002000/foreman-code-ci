import type { FastifyInstance } from 'fastify'

/** An HTTP reply: ok is false for any 4xx or 5xx status, and body is the parsed JSON. */
export interface MaintenanceHttpReply { ok: boolean; statusCode: number; body: unknown }

/**
 * Reads and starts computer maintenance as one bearer caller through the HTTP API, the same service the
 * Computers screen uses. A target read returns that computer only; otherwise every computer is read.
 */
export function computerMaintenanceHttp(app: Pick<FastifyInstance, 'inject'>, token: string) {
  const headers = { authorization: `Bearer ${token}` }
  const reply = (response: { statusCode: number; json: () => unknown }): MaintenanceHttpReply =>
    ({ ok: response.statusCode < 400, statusCode: response.statusCode, body: response.json() })
  return {
    status: async (input: { target?: unknown; refresh?: boolean; taskLimit?: number } = {}) => {
      if (input.target !== undefined) {
        return reply(await app.inject({ method: 'POST', url: '/api/management/computers/maintenance/read', headers, payload: input }))
      }
      const query = new URLSearchParams()
      if (input.refresh !== undefined) query.set('refresh', String(input.refresh))
      if (input.taskLimit !== undefined) query.set('taskLimit', String(input.taskLimit))
      return reply(await app.inject({ method: 'GET', url: `/api/management/computers/maintenance?${query}`, headers }))
    },
    start: async (input: unknown) => reply(await app.inject({
      method: 'POST', url: '/api/management/computers/maintenance/start', headers, payload: input as Record<string, unknown>,
    })),
  }
}

import type { FastifyInstance } from 'fastify'

/** An HTTP reply: ok is false for any 4xx or 5xx status, and body is the parsed JSON. */
export interface StorageFoldersHttpReply { ok: boolean; statusCode: number; body: unknown }

/** Lists and deletes workspace storage folders as one bearer caller through the HTTP API, as the Storage screen does. */
export function workspaceStorageFoldersHttp(app: Pick<FastifyInstance, 'inject'>, token: string) {
  const headers = { authorization: `Bearer ${token}` }
  const reply = (response: { statusCode: number; json: () => unknown }): StorageFoldersHttpReply =>
    ({ ok: response.statusCode < 400, statusCode: response.statusCode, body: response.json() })
  return {
    list: async (input: { limit?: number; cursor?: string } = {}) => {
      const query = new URLSearchParams()
      if (input.limit !== undefined) query.set('limit', String(input.limit))
      if (input.cursor !== undefined) query.set('cursor', input.cursor)
      return reply(await app.inject({ method: 'GET', url: `/api/management/workspace-storage/folders?${query}`, headers }))
    },
    remove: async (input: unknown) => reply(await app.inject({
      method: 'POST', url: '/api/management/workspace-storage/folders/delete', headers, payload: input as Record<string, unknown>,
    })),
  }
}

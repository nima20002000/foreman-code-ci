import fastifyStatic from '@fastify/static'
import type { FastifyInstance } from 'fastify'
import { access } from 'node:fs/promises'
import { isAbsolute, join, sep } from 'node:path'
import { DomainError } from './modules/errors.js'

/** Serve the compiled shell on the API origin, preserving API/MCP error responses. */
export async function registerBuiltWeb(app: FastifyInstance, root: string): Promise<void> {
  if (!isAbsolute(root)) throw new Error('FOREMAN_CODE_WEB_DIST requires an absolute directory.')
  await access(join(root, 'index.html'))
  void app.register(async web => {
    web.setErrorHandler((error, request, reply) => {
      // Static path rejections carry a status but no Fastify error code.
      const failure = error instanceof Error && 'statusCode' in error && error.statusCode === 403
        ? new DomainError('FORBIDDEN', 'The static path is forbidden.', 403) : error
      return app.errorHandler(failure, request, reply)
    })
    void web.register(fastifyStatic, {
      root,
      // Resolve files per request so directory discovery cannot exhaust pluginTimeout under load.
      wildcard: true,
      index: false,
      cacheControl: false,
      setHeaders(reply, path) {
        const cache = path.includes(`${sep}assets${sep}`)
          ? 'public, max-age=31536000, immutable' : 'no-cache'
        reply.header('cache-control', cache)
        reply.header('x-content-type-options', 'nosniff')
      },
    })
    const shellRoutes = [
      '/', '/workspaces', '/workspaces/*', '/settings', '/settings/*',
      '/account', '/terminal', '/approvals',
    ]
    for (const path of shellRoutes) {
      web.get(path, async (_request, reply) => reply.sendFile('index.html'))
    }
  })
}

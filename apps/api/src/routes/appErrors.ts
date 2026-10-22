import type { FastifyInstance } from 'fastify'
import { AppErrorReportSchema } from '@foreman-code/contracts'
import { recordAppError } from '../modules/diagnostics/appErrors.js'

/** The web app reports errors it saw here; they join the API's own errors in the app error log. */
export function registerAppErrorRoutes(app: FastifyInstance): void {
  app.post('/api/app-errors', async (request, reply) => {
    recordAppError({ source: 'web', ...AppErrorReportSchema.parse(request.body) })
    return reply.code(204).send()
  })
}

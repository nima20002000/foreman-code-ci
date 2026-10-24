import { randomBytes, timingSafeEqual } from 'node:crypto'
import Fastify from 'fastify'
import { z } from 'zod'
import { DomainError } from '@foreman-code/contracts/server-kit'
import { HttpCiClient, type CiServiceClient } from '@foreman-code/ci/client'
import { registerCiServiceRoutes } from '@foreman-code/ci/http'
import { logger } from '../../infrastructure/logger.js'
import { databaseConnectionFailure, databaseReadFailure, publicFailureClass } from '../errors.js'

export { HttpCiClient }

/** CI keeps running in Main during this split, behind a private HTTP listener. The process-local credential
 * authenticates Main; the forwarded caller still passes the service's normal live authorization checks. */
export async function createCiHttpTransport(service: CiServiceClient) {
  const app = Fastify({ logger: false })
  const authorization = `Bearer ${randomBytes(32).toString('base64url')}`
  app.setErrorHandler((error, _request, reply) => {
    const mapped = databaseConnectionFailure(databaseReadFailure(error))
    const failure = mapped instanceof DomainError ? mapped : error instanceof z.ZodError
      ? new DomainError('INVALID_REQUEST', 'The request does not match its shared contract.', 400, {
        issues: error.issues,
      })
      : new DomainError('INTERNAL_ERROR', 'CI request failed.', 500, undefined, { cause: error })
    // Preserve the transport handler's choice: HTTP exposes validation issues, while MCP keeps them private.
    if (!(mapped instanceof DomainError)) {
      reply.header('x-ci-error-kind', error instanceof z.ZodError ? 'validation' : 'internal')
      const failureClass = publicFailureClass(error)
      if (failureClass) reply.header('x-ci-failure-class', failureClass)
    }
    if (failure.status >= 500) logger.error({ err: error }, 'CI HTTP request failed')
    if (failure.denialAudited) reply.header('x-ci-denial-audited', 'true')
    return reply.code(failure.status).send({ error: { code: failure.code, message: failure.message,
      ...(failure.details === undefined ? {} : { details: failure.details }) } })
  })
  registerCiServiceRoutes(app, {
    service,
    authenticate: request => {
      const actual = Buffer.from(request.headers.authorization ?? '')
      const expected = Buffer.from(authorization)
      if (actual.length !== expected.length || !timingSafeEqual(actual, expected)) {
        throw new DomainError('AUTHENTICATION_REQUIRED', 'A CI service credential is required.', 401)
      }
    },
  })
  const baseUrl = await app.listen({ host: '127.0.0.1', port: 0 })
  const client = new HttpCiClient({ baseUrl,
    headers: () => ({}),
    service: { headers: () => ({ authorization }) },
  })
  return { client, close: () => app.close() }
}

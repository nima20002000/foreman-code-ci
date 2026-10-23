import { registerRuntimeInstallationSecurity } from './infrastructure/runtimeIdentity.js'
import { randomUUID } from 'node:crypto'
import type { Socket } from 'node:net'
import { scheduleDispatchLog } from './modules/schedules/dispatchErrors.js'

import { ApiErrorResponseSchema } from '@foreman-code/contracts'
import Fastify, { LogController, type FastifyBaseLogger, type FastifyInstance } from 'fastify'
import { z } from 'zod'

import { registerOperatorHttpSecurity, requireLocalRequest } from './modules/access/http.js'
import { DomainError, databaseConnectionFailure, databaseReadFailure, publicFailureClass } from './modules/errors.js'
import { registerApiRoutes, type ApiRouteServices } from './routes/registry.js'
import { DEFAULT_READINESS_TIMEOUT_MS } from './routes/health.js'

export type { ReadinessDependencies } from './routes/health.js'

export interface BuildAppOptions extends ApiRouteServices {
  logger?: boolean | FastifyBaseLogger
  closeInfrastructure?: () => Promise<void>
}

const SLOW_REQUEST_MS = 2000

function publicRequestError(error: unknown): DomainError {
  if (error instanceof DomainError) return error
  if (error instanceof z.ZodError) {
    return new DomainError('INVALID_REQUEST', 'The request does not match its shared contract.', 400, {
      issues: error.issues.map((issue) => ({ path: issue.path, message: issue.message })),
    })
  }
  if (error instanceof Error && 'code' in error) {
    switch (error.code) {
      case 'FST_ERR_CTP_INVALID_JSON_BODY':
      case 'FST_ERR_CTP_EMPTY_JSON_BODY':
        return new DomainError('INVALID_REQUEST', 'The request body must contain valid JSON.', 400)
      case 'FST_ERR_CTP_INVALID_CONTENT_LENGTH':
        return new DomainError('INVALID_REQUEST', 'The request body does not match its Content-Length.', 400)
      case 'FST_ERR_CTP_INVALID_MEDIA_TYPE':
        return new DomainError('UNSUPPORTED_MEDIA_TYPE', 'The request content type is not supported.', 415)
      case 'FST_ERR_CTP_BODY_TOO_LARGE':
        return new DomainError('REQUEST_TOO_LARGE', 'The request body exceeds the allowed size.', 413)
    }
  }
  return new DomainError('INTERNAL_ERROR', 'The API could not complete the request.', 500)
}

export function buildApp(options: BuildAppOptions): FastifyInstance {
  const timeoutMs = options.readinessTimeoutMs ?? DEFAULT_READINESS_TIMEOUT_MS
  if (!Number.isSafeInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 2147483647) {
    throw new RangeError('readinessTimeoutMs must be a positive 32-bit integer')
  }
  const app = Fastify({
    ...(typeof options.logger === 'object'
      ? { loggerInstance: options.logger }
      : { logger: options.logger ?? false }),
    genReqId: () => randomUUID(),
    // Startup hooks can outlast Fastify's 10 s default on a loaded computer; the service manager bounds startup.
    pluginTimeout: 0,
    // Fastify's per-request lines are replaced by one line whose level says whether it matters.
    logController: new LogController({ disableRequestLogging: true }),
  })
  // Fetch pools can replace aborted streams with connections that have no HTTP request yet.
  const unusedConnections = new Set<Socket>()
  let httpClosing = false
  app.server.on('connection', socket => {
    if (httpClosing) {
      socket.destroy()
      return
    }
    unusedConnections.add(socket)
    socket.once('close', () => unusedConnections.delete(socket))
  })
  app.server.on('request', request => unusedConnections.delete(request.socket))
  app.addHook('preClose', async () => {
    httpClosing = true
    for (const socket of unusedConnections) socket.destroy()
    unusedConnections.clear()
  })
  const closeInfrastructure = options.closeInfrastructure
  if (closeInfrastructure) {
    // Fastify closes hooks in reverse order; infrastructure outlives every runtime hook.
    app.addHook('onClose', async () => { await closeInfrastructure() })
  }
  // Timed delivery is an API lifecycle, never a browser or HTTP-request timer.
  app.addHook('onReady', async () => {
    options.operator?.services.runs?.startScheduleDispatcher?.((error, context) => {
      app.log.error(scheduleDispatchLog(error, context), 'schedule dispatch failed; durable state retained for retry')
    })
  })
  app.addHook('preClose', async () => { await options.operator?.services.runs?.stopScheduleDispatcher?.() })
  app.addHook('onResponse', async (request, reply) => {
    const statusCode = reply.statusCode, responseTimeMs = Math.round(reply.elapsedTime)
    // Routine success (the Board polls every 1.5s) is debug; failures and slow calls stay visible.
    // While the API shuts down (a deploy), work it cancels answers 503 API_RESTARTING; that is not a fault.
    const level = statusCode >= 500 ? httpClosing ? 'info' : 'error' : responseTimeMs >= SLOW_REQUEST_MS ? 'warn' : statusCode >= 400 ? 'info' : 'debug'
    // The path without its query string: queries can carry codes and tokens.
    request.log[level]({ method: request.method, path: request.url.split('?')[0], statusCode, responseTimeMs }, 'request completed')
  })
  if (options.operator || options.appMcp) {
    app.addHook('onRequest', async request => { requireLocalRequest(request) })
  }
  if (options.runtimeIdentity) registerRuntimeInstallationSecurity(app, options.runtimeIdentity)
  if (options.operator) registerOperatorHttpSecurity(app, options.operator.access, options.localHuman, options.browserOrigin)
  registerApiRoutes(app, { ...options, readinessTimeoutMs: timeoutMs })

  app.setErrorHandler(async (error, request, reply) => {
    const failure = databaseConnectionFailure(databaseReadFailure(error))
    const failed = publicRequestError(failure)
    const restarting = httpClosing && failed.status >= 500
    const domain = restarting ? new DomainError('API_RESTARTING', 'The API is restarting. Try again in a moment.', 503,
      { retryable: true }) : failed
    const failureClass = publicFailureClass(domain === failed ? failure : domain)
    if (restarting) request.log.info({ err: error, method: request.method, path: request.url.split('?')[0] },
      'request canceled by API shutdown')
    else if (domain.status >= 500) request.log.error({ err: error, method: request.method,
      path: request.url.split('?')[0], statusCode: domain.status }, domain.message)
    const mcpRequest = request.url.split('?')[0] === '/mcp'
    if (mcpRequest && domain.status >= 400 && domain.status < 500 && domain.status !== 401) {
      request.log.warn({ code: domain.code, statusCode: domain.status }, 'MCP request rejected')
    }
    if (options.operator && !domain.denialAudited && (domain.status === 401 || domain.status === 403)
      && (request.url.startsWith('/api/') || mcpRequest)) {
      await options.operator.services.commands.recordDenied(
        request.operatorPrincipal?.id, mcpRequest ? 'mcp' : 'http',
        domain.code, request.url.split('?')[0] ?? request.url,
      ).catch((auditError: unknown) => request.log.error({ err: auditError }, 'management denial audit failed'))
    }
    const body = ApiErrorResponseSchema.parse({
      error: {
        code: domain.code,
        message: domain.message,
        ...(domain.details ? { details: domain.details } : {}),
        ...(failureClass ? { class: failureClass } : {}),
        requestId: request.id,
      },
    })
    return reply.code(domain.status).send(body)
  })

  app.setNotFoundHandler((request, reply) => {
    // A browser address that is not an API route gets the app shell, which shows its own "Page not found".
    if (request.method === 'GET' && typeof reply.sendFile === 'function' && request.headers.accept?.includes('text/html')
      && !/^\/(api|mcp)(\/|$)/.test(request.url)) return reply.code(404).sendFile('index.html')
    const body = ApiErrorResponseSchema.parse({
      error: {
        code: 'NOT_FOUND',
        message: 'The requested API route was not found.',
        requestId: request.id,
      },
    })
    return reply.code(404).send(body)
  })

  return app
}

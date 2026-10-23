// CI's HTTP routes. The host app registers them where it registered its own and supplies the request principal.
import { CiComputersOutputSchema, CiCancelOutputSchema, CiGetInputSchema, CiCancelInputSchema, CiGetOutputSchema, CiListOutputSchema, CiLogsInputSchema, CiLogsOutputSchema, CiRunInputSchema, CiRunOutputSchema,
  CiTestStatusFilterSchema, CiTestsOutputSchema, OperatorCiListInputSchema, OperatorCiRunInputSchema } from '@foreman-code/contracts'
import { CircleAccountAddInputSchema, CircleAccountRemoveInputSchema, ManagementPrincipalSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '@foreman-code/contracts/server-kit'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { CiServiceClient, CiTicketClient } from './client.js'
import type { CircleAccountsManagementService } from './circleAccountsManagement.js'
import type { CiRuntimeProvisioner } from './ciRuntimeProvisioner.js'

/** The authenticated management principal of one request; throws when there is none. */
export type RequestPrincipal = (request: FastifyRequest) => ManagementPrincipal

/** Private service transport. The host authenticates its service credential before any caller data is read;
 * ticket authorization remains in the service, including workspace inference for Agent MCP requests. */
export function registerCiServiceRoutes(app: FastifyInstance, { service, authenticate }: {
  service: CiServiceClient
  authenticate(request: FastifyRequest): void
}): void {
  const workspaceId = z.string().min(1).optional()
  const source = z.enum(['mcp', 'http'])
  const caller = ManagementPrincipalSchema
  const root = '/internal/ci'
  app.addHook('onRequest', async request => { authenticate(request) })
  app.post(root + '/run', async request => {
    const body = z.object({ caller, input: OperatorCiRunInputSchema.safeExtend({ workspaceId }), source }).strict().parse(request.body)
    return CiRunOutputSchema.parse(await service.run(body.caller, body.input, body.source))
  })
  app.post(root + '/get', async (request, reply) => {
    const body = z.object({ caller, input: CiGetInputSchema.extend({ workspaceId }) }).strict().parse(request.body)
    const abort = new AbortController()
    reply.raw.once('close', () => { if (!reply.raw.writableFinished) abort.abort() })
    return CiGetOutputSchema.parse(await service.get(body.caller, body.input, abort.signal))
  })
  app.post(root + '/tests', async request => {
    const body = z.object({ caller, input: z.object({ workspaceId, ticketId: z.string().min(1),
      status: CiTestStatusFilterSchema.optional() }).strict() }).strict().parse(request.body)
    return CiTestsOutputSchema.parse(await service.tests(body.caller, body.input))
  })
  app.post(root + '/list', async request => {
    const body = z.object({ caller, input: OperatorCiListInputSchema.extend({ workspaceId }) }).strict().parse(request.body)
    return CiListOutputSchema.parse(await service.list(body.caller, body.input))
  })
  app.post(root + '/logs', async request => {
    const body = z.object({ caller, input: CiLogsInputSchema.extend({ workspaceId }) }).strict().parse(request.body)
    return CiLogsOutputSchema.parse(await service.logs(body.caller, body.input))
  })
  app.post(root + '/cancel', async request => {
    const body = z.object({ caller, input: CiCancelInputSchema.extend({ workspaceId }), source }).strict().parse(request.body)
    return CiCancelOutputSchema.parse(await service.cancel(body.caller, body.input, body.source))
  })
  app.post(root + '/computers', async request => {
    const body = z.object({ caller, input: z.object({ workspaceId }).strict() }).strict().parse(request.body)
    return CiComputersOutputSchema.parse(await service.computers(body.caller, body.input))
  })
  app.post(root + '/dispatch', async request => {
    z.object({}).strict().parse(request.body)
    await service.dispatch()
    return {}
  })
  app.post(root + '/cancel-stopped-run', async request => {
    const body = z.object({ runId: z.string().min(1) }).strict().parse(request.body)
    await service.cancelStoppedRun(body.runId)
    return {}
  })
  app.post(root + '/expire-overdue-runs', async request => {
    const body = z.object({ now: z.iso.datetime() }).strict().parse(request.body)
    return service.expireOverdueRuns(new Date(body.now))
  })
}

export function registerHostCiRoutes(app: FastifyInstance,
  { services, principal: requirePrincipal }: { services: { ci?: CiTicketClient | undefined }; principal: RequestPrincipal }): void {
  // Production initializes CI after registering the management routes.
  const ci = () => {
    if (!services.ci) throw new DomainError('CI_UNAVAILABLE', 'CI is not initialized yet.', 503)
    return services.ci
  }
  const root = '/api/management/workspaces/:workspaceId/ci'
  app.post<{ Params: { workspaceId: string }; Body: unknown }>(root, async request =>
    CiRunOutputSchema.parse(await ci().run(requirePrincipal(request), {
      ...CiRunInputSchema.parse(request.body), workspaceId: request.params.workspaceId,
    }, 'http')))
  app.get<{ Params: { workspaceId: string } }>(`${root}/computers`, async request =>
    CiComputersOutputSchema.parse(await ci().computers(requirePrincipal(request), request.params)))
  const cancelQuery = CiCancelInputSchema.pick({ commandId: true }).strict()
  app.delete<{ Params: { workspaceId: string; ticketId: string }; Querystring: unknown }>(`${root}/:ticketId`, async request =>
    CiCancelOutputSchema.parse(await ci().cancel(requirePrincipal(request), {
      ...request.params, ...cancelQuery.parse(request.query),
    }, 'http')))
  // The CI tickets of one Run, for the Board's CI component (the Operator uses ci_list).
  const listQuery = OperatorCiListInputSchema.pick({ runId: true, executionId: true }).strict()
  app.get<{ Params: { workspaceId: string }; Querystring: unknown }>(root, async request =>
    CiListOutputSchema.parse(await ci().list(requirePrincipal(request), {
      workspaceId: request.params.workspaceId, ...listQuery.parse(request.query),
    })))
  // ?status=failed,skipped limits the tests (the Operator uses ci_get testStatus).
  const testsQuery = z.object({ status: z.string().max(40).transform(value => value.split(',').filter(Boolean))
    .pipe(CiTestStatusFilterSchema).optional() }).strict()
  app.get<{ Params: { workspaceId: string; ticketId: string }; Querystring: unknown }>(`${root}/:ticketId/tests`, async request =>
    CiTestsOutputSchema.parse(await ci().tests(requirePrincipal(request), {
      ...request.params, ...testsQuery.parse(request.query),
    })))
  // ?waitUntil=group-terminal&waitSeconds=60&logTail=false&testStatus=failed,skipped (the Operator uses ci_get).
  const getQuery = CiGetInputSchema.omit({ ticketId: true }).extend({
    waitSeconds: z.coerce.number().pipe(CiGetInputSchema.shape.waitSeconds.unwrap()).optional(),
    logTail: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
    testStatus: z.string().max(40).transform(value => value.split(',').filter(Boolean)).pipe(CiTestStatusFilterSchema).optional(),
  })
  app.get<{ Params: { workspaceId: string; ticketId: string }; Querystring: unknown }>(`${root}/:ticketId`, async (request, reply) => {
    // A long wait ends when the caller goes away.
    const abort = new AbortController()
    reply.raw.once('close', () => { if (!reply.raw.writableFinished) abort.abort() })
    return CiGetOutputSchema.parse(await ci().get(requirePrincipal(request), {
      ...request.params, ...getQuery.parse(request.query),
    }, abort.signal))
  })
  const logsQuery = CiLogsInputSchema.omit({ ticketId: true }).extend({
    afterOffset: z.coerce.number().int().nonnegative().optional(),
    maxBytes: z.coerce.number().pipe(CiLogsInputSchema.shape.maxBytes.unwrap()).optional(),
    group: z.enum(['true', 'false']).transform(value => value === 'true').optional(),
  })
  app.get<{ Params: { workspaceId: string; ticketId: string }; Querystring: unknown }>(`${root}/:ticketId/logs`, async request =>
    CiLogsOutputSchema.parse(await ci().logs(requirePrincipal(request), {
      ...request.params, ...logsQuery.parse(request.query),
    })))
}

export function registerCircleAccountRoutes(app: FastifyInstance,
  { service, principal: requirePrincipal }: { service: CircleAccountsManagementService; principal: RequestPrincipal }): void {
  const path = '/api/management/settings/circle-accounts'
  app.get(path, request => service.get(requirePrincipal(request)))
  app.post(path, request => service.add(requirePrincipal(request), 'http', CircleAccountAddInputSchema.parse(request.body)))
  app.delete(path, request => service.remove(requirePrincipal(request), 'http', CircleAccountRemoveInputSchema.parse(request.body)))
}

interface Scope {workspaceId:string;profileId:string;approvalId:string}
/** The build computer that holds a verification profile: prepare its CI runtime for a commit, then follow it. */
export function registerComputerPreparationRoutes(app: FastifyInstance,
  { service: ci, principal: requirePrincipal }: { service: Pick<CiRuntimeProvisioner, 'get' | 'start'>; principal: RequestPrincipal }): void {
  const root='/api/management/workspaces/:workspaceId/jobs'
  app.get<{Params:Scope}>(`${root}/runtime-profiles/:profileId/computer-preparation`,request=>ci.get(requirePrincipal(request),{workspaceId:request.params.workspaceId,profileId:request.params.profileId}))
  app.post<{Params:Scope;Body:unknown}>(`${root}/runtime-profiles/:profileId/computer-preparation`,request=>{
    const input=z.object({commandId:z.string().min(1),commit:z.string().optional()}).strict().parse(request.body)
    return ci.start(requirePrincipal(request),'http',{...input,workspaceId:request.params.workspaceId,profileId:request.params.profileId})
  })
}

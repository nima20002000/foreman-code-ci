// CI's HTTP routes. The host app registers them where it registered its own and supplies the request principal.
import { CiComputersOutputSchema, CiCancelOutputSchema, CiGetInputSchema, CiCancelInputSchema, CiGetOutputSchema, CiListOutputSchema, CiLogsInputSchema, CiLogsOutputSchema, CiRunInputSchema, CiRunOutputSchema,
  CiTestStatusFilterSchema, CiTestsOutputSchema, OperatorCiListInputSchema } from '@foreman-code/contracts'
import { CircleAccountAddInputSchema, CircleAccountRemoveInputSchema, type ManagementPrincipal } from '@foreman-code/contracts/management'
import { DomainError } from '@foreman-code/contracts/server-kit'
import { z } from 'zod'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { CiTicketClient } from './client.js'
import type { CircleAccountsManagementService } from './circleAccountsManagement.js'
import type { CiRuntimeProvisioner } from './ciRuntimeProvisioner.js'

/** The authenticated management principal of one request; throws when there is none. */
export type RequestPrincipal = (request: FastifyRequest) => ManagementPrincipal

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

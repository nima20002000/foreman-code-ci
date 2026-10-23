import type { FastifyInstance, FastifyRequest } from 'fastify'
import type { McpServer } from '@modelcontextprotocol/server'
import { HarnessHostReferenceSchema, HarnessRegistryReadbackSchema } from '@foreman-code/contracts/harness-registry'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ProductionHarnessRegistry } from './productionRegistry.js'
import { hasAction } from '../access/policy.js'
import { toolFailure, toolResult } from '../../mcp/shared/results.js'
import { defineOperatorTool } from '../../mcp/operator/definition.js'
import { toolDetail } from '../../mcp/shared/toolDetail.js'

export type HarnessRegistryManagementService = Pick<ProductionHarnessRegistry, 'get'>

/** Read the existing authorized host inventory; this endpoint never discovers or qualifies a runtime. */
export function registerHarnessRegistryRoutes(app: FastifyInstance, service: HarnessRegistryManagementService,
  authenticate: (request: FastifyRequest) => Promise<ManagementPrincipal>): void {
  app.get('/api/management/harnesses/registry', async (request, reply) => {
    const principal = await authenticate(request)
    const host = HarnessHostReferenceSchema.parse(request.query)
    reply.header('cache-control', 'private, no-store').header('vary', 'Authorization, Cookie')
    return HarnessRegistryReadbackSchema.parse(await service.get(principal, host))
  })
}

const description = 'Read a computer\'s harness inventory and every saved global preset, including Claude; match a driver to an '
  + 'installed harness and configure a host profile with harness_instance_save. Performs no discovery, native probe or fallback.'
const detail = 'Enabled saves qualify the profile automatically. Start and placement choices check missing or stale results. '
  + 'Saving and explicit checking require update grants; automatic checks add no grants. '
  + 'Installation, authentication, qualification and connection facts remain separate; '
  + 'the sidebar installation indicator uses installed, without implying authentication or execution readiness. '
  + 'Previously qualified Main and Worker profiles are checked automatically after installed payload changes. '
  + 'harness_instances_list reports pending checks and persisted failure reasons.'
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

async function respond(service: HarnessRegistryManagementService, principal: ManagementPrincipal,
  input: Parameters<HarnessRegistryManagementService['get']>[1]) {
  try { return toolResult(HarnessRegistryReadbackSchema.parse(await service.get(principal, input))) }
  catch (error) { return toolFailure(error, 'The selected computer inventory could not be read.') }
}

export const harnessRegistryTools = [defineOperatorTool({
  name: 'harness_registry_get',
  requires: [['harnesses:read', 'global']],
  enabled: s => !!s.harnessRegistry,
  description,
  detail,
  inputSchema: HarnessHostReferenceSchema, outputSchema: HarnessRegistryReadbackSchema,
  annotations,
  handle: (context, input) => respond(context.services.harnessRegistry!, context.principal, input),
})]

export function registerHarnessRegistryTools(server: McpServer, service: HarnessRegistryManagementService,
  principal: ManagementPrincipal): void {
  if (!hasAction(principal, 'harnesses:read')) return
  server.registerTool('harness_registry_get', { description, ...toolDetail(detail), inputSchema: HarnessHostReferenceSchema,
    outputSchema: HarnessRegistryReadbackSchema, annotations }, input => respond(service, principal, input))
}

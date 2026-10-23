import { collectBoundTools, type BoundTool } from './catalog.js'
import type { McpServer, ServerContext, StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import { CI_TOOL_SPECS, ciToolInputSchema } from '../../modules/ci/tools.js'
import type { CiTicketClient } from '../../modules/ci/types.js'
import type { PostgresCommandCoordinator } from '../../modules/commands/postgres.js'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../modules/access/policy.js'
import { DomainError, databaseConnectionFailure } from '../../modules/errors.js'
import { toolFailure, toolResult } from './results.js'
import { logOperatorToolFailure } from '../operator/invoke.js'
import { deviceBusyFailure } from '../../modules/devices/deviceBusyError.js'

export const CI_TOOLS = ['ci_run', 'ci_get', 'ci_computers_list', 'ci_cancel', 'ci_logs_read', 'ci_list'] as const
type CiTool = typeof CI_TOOLS[number]
interface CiContext {
  principal: ManagementPrincipal
  signal?: AbortSignal
  services: { ci?: CiTicketClient; commands: PostgresCommandCoordinator }
}
export function ciCapabilities(context: CiContext, resource: AuthorizedResource) {
  if (!context.services.ci) return []
  return CI_TOOL_SPECS.filter(spec => spec.requires.every(action =>
    Object.keys(resource).length ? isAuthorized(context.principal, action, resource) : hasAction(context.principal, action)))
    .map(spec => ({ name: spec.name as CiTool, actions: [...spec.requires], detail: spec.detail ?? spec.description }))
}

const catalogs = new WeakMap<object, {
  ci: CiTicketClient; roles: Map<string, BoundTool<CiContext>[]>
}>()

export function registerCiTools(server: McpServer, context: CiContext): void {
  const ci = context.services.ci
  if (!ci) return
  let cached = catalogs.get(context.services)
  if (!cached || cached.ci !== ci) {
    cached = { ci, roles: new Map() }
    catalogs.set(context.services, cached)
  }
  const audience = context.principal.audience
  let tools = cached.roles.get(audience)
  if (!tools) {
    tools = collectBoundTools(context, registerCiToolDefinitions)
    cached.roles.set(audience, tools)
  }
  const available = audience === 'operator' ? new Set(ciCapabilities(context, {}).map(tool => tool.name)) : undefined
  for (const tool of tools) {
    if (!available || available.has(tool.name as CiTool)) tool.register(server, context)
  }
}

function registerCiToolDefinitions(server: McpServer, context: CiContext): void {
  const ci = context.services.ci
  if (!ci) return
  const operator = context.principal.audience === 'operator'
  const invoke = async (name: CiTool, work: () => Promise<unknown>) => {
    try { return toolResult(await work()) }
    catch (caughtError) {
      const error = databaseConnectionFailure(deviceBusyFailure(caughtError))
      logOperatorToolFailure(name, caughtError)
      if (error instanceof DomainError && [401, 403, 404].includes(error.status)) {
        await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `mcp:${name}`)
      } else {
        try {
          await context.services.commands.recordAudit(context.principal.id, 'mcp', name, `mcp:${name}`, 'failed', {
            code: error instanceof DomainError ? error.code : 'INTERNAL_ERROR',
          })
        } catch (auditError) {
          if (!(error instanceof DomainError) || error.code !== 'DATABASE_BUSY') throw auditError
          // A second unavailable connection must not replace the caller's retry instructions.
          logOperatorToolFailure(name, auditError)
        }
      }
      return toolFailure(error)
    }
  }
  for (const spec of CI_TOOL_SPECS) {
    if (spec.operatorOnly && !operator) continue
    server.registerTool(spec.name, {
      description: spec.description,
      inputSchema: ciToolInputSchema(spec, context.principal.audience) as StandardSchemaWithJSON,
      outputSchema: spec.outputSchema as StandardSchemaWithJSON,
      annotations: spec.annotations,
    }, (input: unknown, extra: ServerContext) => invoke(spec.name as CiTool, () => spec.run(ci, context.principal, input, {
      signal: context.signal ? AbortSignal.any([context.signal, extra.mcpReq.signal]) : extra.mcpReq.signal,
    })))
  }
}

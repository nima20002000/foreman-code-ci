import type { McpServer, ServerContext } from '@modelcontextprotocol/server'
import type { ManagementAction, ManagementPrincipal, OperatorToolName } from '@foreman-code/contracts/management'
import { TelemetrySelectorSchema, type TelemetryReadService } from '@foreman-code/contracts/resource-telemetry'
import { hasAction, isAuthorized, type AuthorizedResource } from '../../modules/access/policy.js'
import { toolFailure } from '../shared/results.js'
import { toolDetail } from '../shared/toolDetail.js'
import { readTelemetry, RESOURCE_TELEMETRY_READ_TOOL, type TelemetryDenialAudit } from '../../modules/resource-telemetry/readback/adapters.js'
import { defineOperatorTool } from './definition.js'
import type { OperatorRequestContext } from './types.js'

export const TELEMETRY_READ_ACTIONS: readonly ManagementAction[] = ['devices:metrics:read', 'runs:read', 'jobs:read', 'agent_chat:read', 'operator_chat:read']

/** The telemetry grants are alternatives: an explicit unscoped computer read, or an owned-scope read. */
export function telemetryDiscoverable(context: OperatorRequestContext, resource?: AuthorizedResource): boolean {
  return TELEMETRY_READ_ACTIONS.some(action => action === 'devices:metrics:read'
    ? isAuthorized(context.principal, action, {})
    : resource && Object.keys(resource).length ? isAuthorized(context.principal, action, resource) : hasAction(context.principal, action))
}
export const TELEMETRY_PERMISSION_DETAIL = 'The listed actions are alternatives: computer reads require an explicit unscoped devices:metrics:read grant; owned reads require the relevant Run/Job/conversation grant. The same service rechecks the exact live resource, shared owners, attribution and collector generation on every call.'

export function telemetryDenialAudit(context: OperatorRequestContext, tool: OperatorToolName): TelemetryDenialAudit {
  return { record: (principalId: string, source: 'http' | 'mcp', selectorKey: string) =>
    context.services.commands.recordDenied(principalId, source, tool, selectorKey) }
}

const description = 'Read passive CPU and RAM telemetry (plus free disk for a computer) for one exact computer or owned workflow, CI or conversation selector; values are fresh for six seconds. Never starts collectors, providers or processes.'
const detail = 'Requires a live explicit whole-computer telemetry grant or the exact role-specific owned-scope grant; Agent/Run access never implies computer permission. Denied results expose no cached values. Never starts pairing.'
const annotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }

async function respond(reads: TelemetryReadService<ManagementPrincipal>, principal: ManagementPrincipal,
  input: unknown, extra: ServerContext, audit: TelemetryDenialAudit) {
  try {
    const result = await readTelemetry(reads, principal, input, extra.mcpReq.signal, 'mcp', audit)
    return { ...(result.kind === 'denied' ? { isError: true } : {}),
    content: [{ type: 'text' as const, text: JSON.stringify(result) }], structuredContent: result }
  } catch (error) { return toolFailure(error) }
}

export const resourceTelemetryTool = defineOperatorTool({
  name: RESOURCE_TELEMETRY_READ_TOOL,
  requires: [['devices:metrics:read', 'global'], ['runs:read', 'resource'], ['jobs:read', 'resource'], ['agent_chat:read', 'resource'], ['operator_chat:read', 'resource']],
  enabled: s => !!s.resourceTelemetry,
  discoverable: telemetryDiscoverable,
  permissionDetail: TELEMETRY_PERMISSION_DETAIL,
  description,
  detail,
  inputSchema: TelemetrySelectorSchema,
  annotations,
  handle: (context, input, { extra }) => respond(context.services.resourceTelemetry!.reads, context.principal, input, extra,
    telemetryDenialAudit(context, RESOURCE_TELEMETRY_READ_TOOL)),
})

/** Tool listing is discovery only: the shared service resolves the exact live grant on every call. */
export function registerResourceTelemetryTools(server: McpServer, principal: ManagementPrincipal,
  reads: TelemetryReadService<ManagementPrincipal>, audit: TelemetryDenialAudit): void {
  server.registerTool(RESOURCE_TELEMETRY_READ_TOOL, { description, ...toolDetail(detail), inputSchema: TelemetrySelectorSchema, annotations },
    (input, extra) => respond(reads, principal, input, extra, audit))
}

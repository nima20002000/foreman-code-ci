import type { McpServer, ServerContext, Tool, ToolAnnotations } from '@modelcontextprotocol/server'
import { z } from 'zod'
import { OperatorToolSchemaInputSchema } from '@foreman-code/contracts/operator-mcp'
import type { ManagementAction } from '@foreman-code/contracts/management'
import { DomainError } from '../../modules/errors.js'
import { toolFailure, toolResult } from '../shared/results.js'
import { compactJsonSchema, firstSentence } from '../shared/schemaCompaction.js'
import { readToolDetail } from '../shared/toolDetail.js'
import type { OperatorCatalog } from './presentation.js'

/**
 * Operator tools/list carries only this core set plus the discovery tools, so a model turn stays
 * small. Every other caller-available tool stays reachable through tools_find, tool_schema and
 * tool_run/tool_run_read, and by a direct tools/call of its name.
 */
export const OPERATOR_CORE_TOOLS: ReadonlySet<string> = new Set([
  'workspace_list', 'workspace_get', 'workspace_create',
  'workflow_list', 'workflow_get',
  'agent_list', 'agent_get',
  'run_list', 'run_get', 'run_start', 'run_stop',
  'workflow_chat_read', 'workflow_chat_post', 'agent_chat_read', 'agent_chat_send',
  'interaction_list', 'interaction_respond', 'bug_report',
])
export const TOOL_RUN = 'tool_run'
export const TOOL_RUN_READ = 'tool_run_read'
export const OPERATOR_DISCOVERY_TOOLS: ReadonlySet<string> = new Set(['tools_find', 'tool_schema', TOOL_RUN_READ, TOOL_RUN])
/** These read the caller's full catalog, so every available tool is registered for them. */
export const OPERATOR_CATALOG_TOOLS: ReadonlySet<string> = new Set(['tools_find', 'tool_schema'])

export function operatorListedTool(name: string): boolean {
  return OPERATOR_CORE_TOOLS.has(name) || OPERATOR_DISCOVERY_TOOLS.has(name)
}

export const OPERATOR_DISCOVERY_INSTRUCTIONS = 'tools/list shows only core tools. For anything else, call tools_find '
  + 'with a short query, then tool_schema for the chosen tool, then tool_run_read (read-only tools) or tool_run '
  + '(changes) with { name, arguments }. tool_run behaves exactly like calling the tool directly. '
  + 'tool_schema also returns a tool\'s detail and required actions: read it before a tool\'s first use. '
  + 'Tools that take a commandId are idempotent: after an uncertain reply, retry with the same commandId and input; '
  + 'different input under a used commandId conflicts. A stale expectedRevision returns REVISION_CONFLICT; '
  + 'where expectedRevision is optional, omitting it means last write wins. Every call rechecks your grants and scope; '
  + 'operator_get_capabilities lists the actions each tool requires.'

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const RunInput = z.object({
  name: z.string().min(1).max(200).describe('Exact tool name from tools_find.'),
  arguments: z.record(z.string(), z.unknown()).optional().describe('The tool input, matching tool_schema.'),
})

function terms(query: string | undefined): string[] {
  return (query ?? '').toLowerCase().split(/[^a-z0-9]+/).filter(Boolean)
    .map(term => term.length > 3 && term.endsWith('s') ? term.slice(0, -1) : term)
}

/** Name matches rank above description and detail matches; every matched term counts. */
export function findTools(tools: readonly Tool[], query: string | undefined) {
  const wanted = terms(query)
  const scored = tools.filter(tool => !OPERATOR_DISCOVERY_TOOLS.has(tool.name)).map(tool => {
    const name = tool.name.toLowerCase()
    const description = `${tool.description ?? ''} ${readToolDetail(tool) ?? ''}`.toLowerCase()
    const score = wanted.reduce((sum, term) => sum + (name.includes(term) ? 3 : description.includes(term) ? 1 : 0), 0)
    return { tool, score }
  }).filter(entry => !wanted.length || entry.score > 0)
  scored.sort((left, right) => right.score - left.score || left.tool.name.localeCompare(right.tool.name))
  return scored.map(({ tool }) => ({ name: tool.name, summary: firstSentence(tool.description).slice(0, 200),
    readOnly: tool.annotations?.readOnlyHint === true }))
}

/** The actions a tool needs and how they combine, for callers allowed to read capabilities. */
export type OperatorToolRequirement = (name: string) => { actions?: ManagementAction[]; detail: string } | undefined

/**
 * What discovery needs to know about the caller. requirement is supplied only for callers holding
 * capabilities:read, as operator_get_capabilities requires. recordDenied audits a lookup of a tool the caller cannot use.
 */
export interface OperatorDiscoveryCaller {
  requirement?: OperatorToolRequirement | undefined
  recordDenied(toolName: string): Promise<void>
}

/** Discovery reads the caller's own grant-filtered catalog; it never exposes another tool. */
export function registerOperatorDiscoveryTools(server: McpServer, catalog: () => OperatorCatalog | undefined,
  caller?: OperatorDiscoveryCaller): void {
  const tools = async (extra: ServerContext) => (await catalog()?.(extra)) ?? []
  server.registerTool('tools_find', {
    description: 'Find available tools that are not in the core list, by name and one-line summary. '
      + 'Pass a short query such as "schedule" or "circle account"; omit it to list everything.',
    inputSchema: z.object({ query: z.string().max(200).optional() }),
    annotations: read,
  }, async (input: { query?: string | undefined }, extra: ServerContext) => {
    const found = findTools(await tools(extra), input.query)
    return toolResult({ tools: found, next: 'Call tool_schema for one name, then tool_run_read or tool_run.' })
  })
  server.registerTool('tool_schema', {
    description: 'Read one available tool’s description, detail, input schema, annotations and permission requirements before calling it with tool_run. '
      + 'Set includeOutputSchema:true for its output schema. This read never invokes the tool.',
    inputSchema: OperatorToolSchemaInputSchema,
    annotations: read,
  }, async (input: { name: string; includeOutputSchema?: boolean | undefined }, extra: ServerContext) => {
    const tool = (await tools(extra)).find(candidate => candidate.name === input.name)
    if (!tool || OPERATOR_DISCOVERY_TOOLS.has(tool.name)) {
      await caller?.recordDenied('tool_schema')
      return toolFailure(new DomainError('ACCESS_DENIED', 'The requested tool is unavailable to this caller. Use tools_find.', 403))
    }
    const readOnly = tool.annotations?.readOnlyHint === true
    const detail = readToolDetail(tool)
    const permissions = caller?.requirement?.(tool.name)
    return toolResult({ name: tool.name, description: tool.description ?? '', ...(detail ? { detail } : {}),
      inputSchema: compactJsonSchema(tool.inputSchema),
      ...(input.includeOutputSchema && tool.outputSchema ? { outputSchema: compactJsonSchema(tool.outputSchema) } : {}),
      ...(tool.annotations ? { annotations: tool.annotations } : {}),
      ...(permissions ? { permissionRequirements: permissions } : {}), callWith: readOnly ? TOOL_RUN_READ : TOOL_RUN })
  })
  // The /mcp endpoint dispatches valid tool_run calls as direct calls of the named tool (dispatchToolRun),
  // so these handlers run only when that dispatch is not composed.
  const undispatched = () => toolFailure(new DomainError('TOOL_RUN_UNAVAILABLE',
    'tool_run is dispatched by the authenticated /mcp endpoint only.', 503))
  server.registerTool(TOOL_RUN_READ, {
    description: 'Run one read-only tool by name with its arguments, exactly as calling it directly. Refuses tools that change state.',
    inputSchema: RunInput, annotations: read,
  }, undispatched)
  server.registerTool(TOOL_RUN, {
    description: 'Run one tool by name with its arguments, exactly as calling it directly, with the same validation, permissions and audit.',
    inputSchema: RunInput,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: false },
  }, undispatched)
}

const RunCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'),
  params: z.object({ name: z.enum([TOOL_RUN, TOOL_RUN_READ]), arguments: RunInput }).passthrough(),
}).passthrough()

/**
 * Rewrites a valid tool_run/tool_run_read request into the direct tools/call of its target, before
 * any denial, audit, registration or SDK handling, so both take exactly one path. tool_run_read
 * refuses targets not annotated readOnlyHint. Invalid requests are left for the SDK to reject.
 */
export function dispatchToolRun(body: unknown, annotations: (name: string) => ToolAnnotations | undefined | null):
  { body: unknown } | { failure: { jsonrpc: '2.0'; id: string | number; result: ReturnType<typeof toolFailure> } } {
  const call = RunCall.safeParse(body)
  if (!call.success) return { body }
  const { name, arguments: input } = call.data.params.arguments
  const fail = (error: DomainError) => ({ failure: { jsonrpc: '2.0' as const, id: call.data.id, result: toolFailure(error) } })
  if (OPERATOR_DISCOVERY_TOOLS.has(name)) {
    return fail(new DomainError('INVALID_REQUEST', 'Call discovery tools directly, not through tool_run.', 400))
  }
  if (call.data.params.name === TOOL_RUN_READ) {
    const hints = annotations(name)
    if (hints === null) return fail(new DomainError('TOOL_NOT_FOUND', 'No tool has this name. Use tools_find.', 404))
    if (hints?.readOnlyHint !== true) {
      return fail(new DomainError('TOOL_NOT_READ_ONLY', `${name} changes state; tool_run_read runs only read-only tools.`, 403))
    }
  }
  const { arguments: _wrapper, name: _name, ...params } = call.data.params
  void _wrapper; void _name
  return { body: { ...call.data, params: { ...params, name, arguments: input ?? {} } } }
}

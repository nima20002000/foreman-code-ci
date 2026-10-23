import { z } from 'zod'
import type { McpServer } from '@modelcontextprotocol/server'
import {
  FileRetentionGetInputSchema, FileRetentionGetResultSchema,
  FileRetentionPreviewInputSchema, FileRetentionPreviewResultSchema,
  FileRetentionSaveInputSchema, FileRetentionSaveResultSchema,
} from '@foreman-code/contracts/files'

import { DomainError } from '../../../modules/errors.js'
import { fileRetentionGrantsAllow } from '../../../modules/files/retention.js'
import { toolFailure, toolResult } from '../../shared/results.js'
import { toolDetail } from '../../shared/toolDetail.js'
import type { OperatorRequestContext } from '../types.js'

// Backend registration names only. The frozen management OperatorToolName enum does not include FIL-40.
export const FILE_RETENTION_TOOL_NAMES = ['file_retention_get', 'file_retention_preview', 'file_retention_save'] as const
export type FileRetentionToolName = typeof FILE_RETENTION_TOOL_NAMES[number]

export function fileRetentionToolAvailable(context: OperatorRequestContext, name: FileRetentionToolName): boolean {
  return Boolean(context.services.fileRetention) && fileRetentionGrantsAllow(context.principal, name === 'file_retention_save')
}
async function invoke(work: () => Promise<unknown>) {
  // Authorization denial audit is shared by both transports in FileRetentionService.
  try { return toolResult(await work()) } catch (error) { return toolFailure(error) }
}

export function registerFileRetentionTools(server: McpServer, context: OperatorRequestContext): void {
  const service = context.services.fileRetention
  if (!service) return
  const ownerRule = 'Uses only your own non-delegated human-owner credential; never accepts another owner ID. Worker and delegated Operator/Run credentials cannot manage this setting. Requires unscoped settings grants. '
  if (fileRetentionToolAvailable(context, 'file_retention_get')) server.registerTool('file_retention_get', {
    description: 'Read your temporary chat file retention preference and revision; unset means 7 days, revision 0. Permanent references never expire.',
    ...toolDetail(ownerRule.trim()),
    inputSchema: FileRetentionGetInputSchema, outputSchema: FileRetentionGetResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invoke(() => service.get(context.principal, 'mcp', input)))
  if (fileRetentionToolAvailable(context, 'file_retention_preview')) server.registerTool('file_retention_preview', {
    description: 'Count the still-live temporary files a proposed retention (3600–31536000 integer seconds) would expire now, from their creation time. Changes nothing.',
    ...toolDetail(ownerRule.trim()),
    inputSchema: FileRetentionPreviewInputSchema, outputSchema: FileRetentionPreviewResultSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, async (input) => invoke(() => service.preview(context.principal, 'mcp', input)))
  if (fileRetentionToolAvailable(context, 'file_retention_save')) server.registerTool('file_retention_save', {
    description: 'Save your temporary chat file retention (3600–31536000 integer seconds) for future files, or with applyToExisting true also for still-live files, which may expire them immediately. Returns the saved preference and affected counts.',
    ...toolDetail(ownerRule + 'Never resurrects overdue/expired/removed files or touches references. Read back with file_retention_get.'),
    inputSchema: FileRetentionSaveInputSchema, outputSchema: FileRetentionSaveResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
  }, async (input) => invoke(() => service.save(context.principal, 'mcp', input)))
}

const ToolCall = z.object({ jsonrpc: z.literal('2.0'), id: z.union([z.string(), z.number().int()]),
  method: z.literal('tools/call'), params: z.object({ name: z.enum(FILE_RETENTION_TOOL_NAMES) }).passthrough() }).passthrough()

/** Direct calls to grant-hidden tools get an audited denial, not a misleading unknown-tool error. */
export async function unavailableFileRetentionToolCall(context: OperatorRequestContext, body: unknown) {
  const call = ToolCall.safeParse(body)
  if (!call.success || fileRetentionToolAvailable(context, call.data.params.name)) return undefined
  const name = call.data.params.name
  const allowed = fileRetentionGrantsAllow(context.principal, name === 'file_retention_save')
  if (!allowed) await context.services.commands.recordDenied(context.principal.id, 'mcp', name, `file-retention:${context.principal.id}`)
  const error = allowed
    ? new DomainError('FILE_RETENTION_UNAVAILABLE', 'File retention is not installed in this API composition.', 503)
    : new DomainError('ACCESS_DENIED', 'The caller lacks unscoped file-retention settings grants.', 403)
  return { jsonrpc: '2.0' as const, id: call.data.id, result: toolFailure(error) }
}

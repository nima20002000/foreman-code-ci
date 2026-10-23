import {
  BugReportCreateInputSchema,
  BugReportCreateResultSchema,
  type ManagementPrincipal,
} from '@foreman-code/contracts/management'
import type { McpServer } from '@modelcontextprotocol/server'

import type { BugReportService } from '../../modules/bug-reports/service.js'
import type { toolFailure, toolResult } from './results.js'
import { toolDetail } from './toolDetail.js'

export const BUG_REPORT_TOOL_DESCRIPTION = 'Report a Foreman Code feature or MCP tool that fails or is hard to use: title, '
  + 'tried.feature, tried.inputsSummary (no secrets), happened.errorCode/message, expected and severity. '
  + 'A title matching an existing report in the workspace increments its occurrenceCount instead of filing again.'
export const BUG_REPORT_TOOL_DETAIL = 'The server redacts recognized tokens and derives reporter, time and harness. '
  + 'Agent workspace/run/workflow come from the authenticated execution; Operator workspace must be supplied unless '
  + 'one authorized workspace is unambiguous. Titles match ignoring case and spacing; outcome/message then say it was '
  + 'already filed with its id and status. A repeat of a report closed as fixed reopens it as a regression (outcome reopened). '
  + 'Always available to workflow Agents regardless of saved tool choices. A match owned by another reporter returns only '
  + 'report.id, report.status and report.title. Requires the explicit bug_reports:report grant in scope.'

export function registerBugReportTool(server: McpServer, context: {
  principal: ManagementPrincipal
  service: BugReportService
  invoke: (work: () => Promise<unknown>) => Promise<ReturnType<typeof toolResult> | ReturnType<typeof toolFailure>>
}): void {
  const inputSchema = context.principal.audience === 'worker'
    ? BugReportCreateInputSchema.omit({ workspaceId: true })
    : BugReportCreateInputSchema
  server.registerTool('bug_report', {
    description: BUG_REPORT_TOOL_DESCRIPTION,
    ...toolDetail(BUG_REPORT_TOOL_DETAIL),
    inputSchema,
    outputSchema: BugReportCreateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
  }, input => context.invoke(() => context.service.report(
    context.principal, 'mcp', input,
  )))
}

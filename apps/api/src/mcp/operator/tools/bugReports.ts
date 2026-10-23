import {
  BugReportCloseInputSchema,
  BugReportCloseResultSchema,
  BugReportGetInputSchema,
  BugReportListInputSchema,
  BugReportPageSchema,
  BugReportSchema,
  BugReportUpdateInputSchema,
  BugReportUpdateResultSchema,
  BugReportCreateInputSchema,
  BugReportCreateResultSchema,
} from '@foreman-code/contracts/management'

import { BUG_REPORT_TOOL_DESCRIPTION, BUG_REPORT_TOOL_DETAIL } from '../../shared/bugReports.js'
import { defineOperatorTool } from '../definition.js'

const readAnnotations = {
  readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false,
} as const

export const bugReportTools = [
  defineOperatorTool({
    name: 'bug_report',
    requires: [['bug_reports:report', 'resource']],
    enabled: s => !!s.bugReports,
    description: BUG_REPORT_TOOL_DESCRIPTION,
    detail: BUG_REPORT_TOOL_DETAIL,
    inputSchema: BugReportCreateInputSchema,
    outputSchema: BugReportCreateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.bugReports!.report(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'bug_reports_list',
    requires: [['bug_reports:read', 'resource']],
    enabled: s => !!s.bugReports,
    description: 'List bug reports newest first: active (open or triaged) by default, or view "history" for closed ones with resolution, note and closedAt. Filter by status, workspaceId or severity; follow pageInfo.nextCursor.',
    detail: 'A status filter narrows the view, or selects that status alone when view is omitted.',
    inputSchema: BugReportListInputSchema,
    outputSchema: BugReportPageSchema,
    annotations: readAnnotations,
    run: (context, input) => context.services.bugReports!.list(context.principal, input),
  }),
  defineOperatorTool({
    name: 'bug_report_get',
    requires: [['bug_reports:read', 'resource']],
    enabled: s => !!s.bugReports,
    description: 'Read a persisted Foreman Code bug report, including reporter, execution scope, harness, '
      + 'occurrence count and current revision. Requires bug_reports:read in the report scope.',
    inputSchema: BugReportGetInputSchema,
    outputSchema: BugReportSchema,
    annotations: readAnnotations,
    run: (context, input) => context.services.bugReports!.get(context.principal, input.reportId),
  }),
  defineOperatorTool({
    name: 'bug_report_update',
    requires: [['bug_reports:update', 'resource']],
    enabled: s => !!s.bugReports,
    description: 'Mark a Foreman Code bug report open or triaged with its expectedRevision, which also reopens a closed report; close reports with bug_reports_close.',
    detail: 'Previously saved fixed/wont-fix update commands can still be retried with their original input; new closed-status updates are rejected. A different command with a stale revision conflicts.',
    inputSchema: BugReportUpdateInputSchema,
    outputSchema: BugReportUpdateResultSchema,
    annotations: { ...readAnnotations, readOnlyHint: false },
    run: (context, input) => context.services.bugReports!.update(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'bug_reports_close',
    requires: [['bug_reports:update', 'resource'], ['bug_reports:read', 'resource']],
    enabled: s => !!s.bugReports,
    description: 'Close one or more bug reports all-or-nothing as fixed, wont-fix or duplicate (with duplicateOfId in the same workspace), each with its expectedRevision, and an optional short note.',
    detail: 'Closed reports are archived from the default bug_reports_list view. Any stale revision rejects the whole call. A later repeat of a fixed report reopens it as a regression. Requires bug_reports:read and bug_reports:update on every report (and bug_reports:read on the duplicate target).',
    inputSchema: BugReportCloseInputSchema,
    outputSchema: BugReportCloseResultSchema,
    annotations: { ...readAnnotations, readOnlyHint: false },
    run: (context, input) => context.services.bugReports!.close(context.principal, 'mcp', input),
  }),
]

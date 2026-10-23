import { RunSubagentsListInputSchema, RunSubagentGetInputSchema, RunSubagentItemsInputSchema, RunSubagentInputSchema, RunSubagentInterruptSchema,
  RunSubagentsPageSchema, RunSubagentDetailSchema, RunSubagentMessagesPageSchema, RunSubagentToolsPageSchema,
  RunSubagentCommandReceiptSchema, RunSubagentRespondSchema } from '@foreman-code/contracts/subagents'
import { defineOperatorTool } from '../definition.js'

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const command = { ...read, readOnlyHint: false }
export const subagentTools = [
  defineOperatorTool({
    name: 'run_subagents_list_v1',
    requires: [['runs:read', 'run']],
    enabled: s => !!s.runs?.subagents,
    description: 'List the native children of one Run, including completed ones, with native mode, evidence, coverage and qualified capabilities. Never edits the saved Board.',
    detail: 'When projection is busy, returns saved children with projection catching-up; poll again for newer activity.',
    inputSchema: RunSubagentsListInputSchema, outputSchema: RunSubagentsPageSchema, annotations: read,
    run: (context, input) => context.services.runs.subagents!.list(context.principal, input),
  }),
  defineOperatorTool({
    name: 'run_subagent_get_v1',
    requires: [['runs:read', 'run']],
    enabled: s => !!s.runs?.subagents,
    description: 'Read one native child of a Run, its pending native interaction and its currently available actions.',
    detail: 'Native protocol support, app qualification and live computer ownership are separate; unavailable controls grant no session access. Codex supports child turn steering, idle input, targeted interruption and explicit approval/input responses through its admitted owner.',
    inputSchema: RunSubagentGetInputSchema, outputSchema: RunSubagentDetailSchema, annotations: read,
    run: (context, input) => context.services.runs.subagents!.get(context.principal, input),
  }),
  defineOperatorTool({
    name: 'run_subagent_messages_list_v1',
    requires: [['runs:read', 'run']],
    enabled: s => !!s.runs?.subagents,
    description: 'Read a bounded chronological child transcript page with native identity, provenance, finality and truncation/coverage. Re-read from the start to refresh changed messages; cursor is for older immutable ordering, scoped to this child.',
    inputSchema: RunSubagentItemsInputSchema, outputSchema: RunSubagentMessagesPageSchema, annotations: read,
    run: (context, input) => context.services.runs.subagents!.messages(context.principal, input),
  }),
  defineOperatorTool({
    name: 'run_subagent_tools_list_v1',
    requires: [['runs:read', 'run']],
    enabled: s => !!s.runs?.subagents,
    description: 'Read child tool calls and native results with sanitized arguments, errors, timings and truncation/coverage. Tool-like model text is never execution evidence. Requires scoped runs:read.',
    inputSchema: RunSubagentItemsInputSchema, outputSchema: RunSubagentToolsPageSchema, annotations: read,
    run: (context, input) => context.services.runs.subagents!.tools(context.principal, input),
  }),
  defineOperatorTool({
    name: 'run_subagent_input_v1',
    requires: [['runs:subagents:input', 'run'], ['runs:read', 'run']],
    enabled: s => !!s.runs?.subagents,
    description: 'Send input to one native child where qualified, available and owned by its admitted computer manager, pinning expectedRevision. A native ACK is acceptance, not consumption; Claude direct input is unavailable.',
    detail: 'Requires runs:read plus explicit runs:subagents:input on the same Run. Uncertain retries read the receipt without resending. Codex active input targets the child turn; idle input preserves the child settings.',
    inputSchema: RunSubagentInputSchema, outputSchema: RunSubagentCommandReceiptSchema, annotations: command,
    run: (context, input) => context.services.runs.subagents!.input(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'run_subagent_interrupt_v1',
    requires: [['runs:stop', 'run'], ['runs:read', 'run']],
    enabled: s => !!s.runs?.subagents,
    description: 'Interrupt one active native child through qualified targeted cancellation, pinning expectedRevision; the ACK never marks the child finished.',
    detail: 'ACK never marks the child finished; observed provider cancellation remains required. Codex interruption addresses the child thread and turn. Requires the current computer lease.',
    inputSchema: RunSubagentInterruptSchema, outputSchema: RunSubagentCommandReceiptSchema, annotations: { ...command, destructiveHint: true },
    run: (context, input) => context.services.runs.subagents!.interrupt(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'run_subagent_respond_v1',
    requires: [['interactions:respond', 'run'], ['runs:read', 'run']],
    enabled: s => !!s.runs?.subagents,
    description: 'Answer a native child\'s callback from run_subagent_get_v1 with its nativeRequestId, an offered optionId and, for questions and forms, a response, pinning expectedRevision. Uncertain responses are never resent.',
    inputSchema: RunSubagentRespondSchema, outputSchema: RunSubagentCommandReceiptSchema, annotations: command,
    run: (context, input) => context.services.runs.subagents!.respond(context.principal, 'mcp', input),
  }),
]

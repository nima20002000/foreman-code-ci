import { CurrentWorkflowCreateInputSchema, DEFAULT_WORKFLOW_EXECUTION_POLICY } from '@foreman-code/contracts/current'
import { SavedManagedWorkflowCommandResultSchema as ManagedWorkflowCommandResultSchema,
  SavedManagedWorkflowPageSchema as ManagedWorkflowPageSchema, SavedManagedWorkflowSchema as ManagedWorkflowSchema } from '@foreman-code/contracts/current'

import {
  WorkflowBatchArchiveInputSchema, WorkflowBatchArchiveResultSchema,
  WorkflowArchiveInputSchema, WorkflowGetInputSchema,
  WorkflowUpdateInputSchema,
} from '@foreman-code/contracts/management'
import { OperatorWorkflowListInputSchema, WorkflowSummaryPageSchema } from '@foreman-code/contracts/operator-mcp'
import { defineOperatorTool } from '../definition.js'

export const workflowTools = [
  defineOperatorTool({
    name: 'workflow_list',
    requires: [['workflows:read', 'resource']],
    enabled: s => !!s.workflows,
    description: 'List workflow summaries in saved workspace order, including empty workflows (10 by default); pass pageInfo.nextCursor as cursor until null. detail: "full" or workflow_get returns the saved definition.',
    detail: 'Each page includes the workspace's orderRevision; it is 0 when no read grant applies to this workspace. Restart pagination after order or membership changes.',
    inputSchema: OperatorWorkflowListInputSchema,
    outputSchema: WorkflowSummaryPageSchema.or(ManagedWorkflowPageSchema),
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: async (context, { detail, ...input }) => {
    const page = await context.services.workflows.list(context.principal, input)
    if (detail === 'full') return page
    return {
      detail: 'compact', pageInfo: page.pageInfo, orderRevision: page.orderRevision,
      items: page.items.map(({ workflow, ...item }) => ({
        ...item, workflow: { id: workflow.id, workspaceId: workflow.workspaceId, name: workflow.name },
        detailsOmitted: true,
      })),
    }
  },
  }),
  defineOperatorTool({
    name: 'workflow_get',
    requires: [['workflows:read', 'resource']],
    enabled: s => !!s.workflows,
    description: 'Read a workflow and its current saved version reference.', inputSchema: WorkflowGetInputSchema,
    outputSchema: ManagedWorkflowSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.workflows.get(context.principal, input.workspaceId, input.workflowId),
  }),
  defineOperatorTool({
    name: 'workflow_create',
    requires: [['workflows:create', 'workspace']],
    enabled: s => !!s.workflows,
    description: 'Create a named semantics-3 workflow from the global workflow defaults; provide initialSave '
      + '{graph, expectedAgentConfigurationVersionIds} to create and save it atomically. Later graph edits use workflow_validate_v3 and workflow_save_v3.',
    detail: 'The built-in approval handler is native; saved global defaults take precedence. '
      + `New workflows start with executionPolicy ${JSON.stringify(DEFAULT_WORKFLOW_EXECUTION_POLICY)}; change it with the workflow edit tools. `
      + 'Omit initialSave for an unsaved workflow. '
      + 'Omitted graph.approval uses the workflow creation default; explicit orchestrator handling requires a designated reviewer. '
      + 'The graph omits workflow identity, name, description, defaultWorktree and timestamps; '
      + 'creation supplies those fields. Invalid graphs or configuration references leave no workflow. '
      + 'Initial save additionally requires workflows:read/update, graph:read/edit/save, agents:read '
      + 'and workspace_locations:read, and referenced skill/harness/source grants, '
      + 'scoped to the workspace without workflow-ID restrictions. '
      + 'Read back with workflow_saved_get_v3. '
      + 'Omit defaultWorktree to copy the ready workspace project root; pass null to opt out '
      + 'or {rootBinding,branchPrefix?} to select an approved immutable Git source. '
      + 'Worktree selection requires sources:read, source_roots:read and workspace_locations:read. '
      + 'Agents inherit that root unless node.placement overrides it; each writable execution gets '
      + 'its own directory and uniquely suffixed branch.',
    inputSchema: CurrentWorkflowCreateInputSchema,
    outputSchema: ManagedWorkflowCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.workflows.create(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'workflow_update',
    requires: [['workflows:update', 'resource']],
    enabled: s => !!s.workflows,
    description: 'Revision-check and rename or describe a workflow. For current graph and workflow settings use workflow_validate_v3 and workflow_save_v3 with exact pins; unresolved staged edits require their existing Stop-and-save/Discard protocol. Global workflow_defaults_update affects only future workflows.', inputSchema: WorkflowUpdateInputSchema,
    outputSchema: ManagedWorkflowCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.workflows.update(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'workflow_batch_archive',
    requires: [['workflows:archive', 'resource']],
    enabled: s => !!s.workflows,
    description: 'Atomically delete (archive) 1–100 selected workflows, retaining versions and runs. Requires archive permission for every workflow and its expected revision. Active runs or any conflict reject the entire batch. Retry an uncertain outcome with the same commandId and input.',
    inputSchema: WorkflowBatchArchiveInputSchema, outputSchema: WorkflowBatchArchiveResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.workflows.archiveBatch(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'workflow_archive',
    requires: [['workflows:archive', 'resource']],
    enabled: s => !!s.workflows,
    description: 'Archive a settled workflow while retaining versions and runs.', inputSchema: WorkflowArchiveInputSchema,
    outputSchema: ManagedWorkflowCommandResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.workflows.archive(context.principal, 'mcp', input),
  }),
]

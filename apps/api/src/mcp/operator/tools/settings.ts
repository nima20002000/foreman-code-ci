import { operatorControlTools } from './operatorControls.js'
import { z } from 'zod'
import { OperatorChatSetupSchema, OperatorChatSetupQuerySchema } from '@foreman-code/contracts'
import { operatorChatTools } from './operatorChat.js'

import type { StandardSchemaWithJSON } from '@modelcontextprotocol/server'
import {
  type OperatorToolName,
  WorkerExecutionSettingsSchema,
  ManagedRemoteExecutionSettingsSchema,
  RemoteExecutionSettingsUpdateInputSchema,
  RemoteExecutionSettingsUpdateResultSchema,
  ManagedGeneralSettingsSchema,
  ManagedCircleCreditAllowanceSchema,
  CircleCreditAllowanceUpdateInputSchema,
  CircleCreditAllowanceUpdateResultSchema,
  GeneralSettingsUpdateInputSchema,
  GeneralSettingsUpdateResultSchema,
  ManagedPromptSettingSchema,
  PromptSettingUpdateInputSchema,
  PromptSettingUpdateResultSchema,
  AgentDefaultsUpdateInputSchema,
  AgentDefaultsUpdateResultSchema,
  ManagedAgentDefaultsSchema,
  ManagedWorkflowDefaultsSchema,
  WorkflowDefaultsUpdateInputSchema,
  WorkflowDefaultsUpdateResultSchema,
} from '@foreman-code/contracts/management'
import { defineOperatorTool, grants } from '../definition.js'
import { CIRCLE_ACCOUNT_TOOL_SPECS, ciToolInputSchema } from '../../../modules/ci/tools.js'

export const settingsTools = [
  // CircleCI login settings: CI's own tool specs.
  ...CIRCLE_ACCOUNT_TOOL_SPECS.map(spec => defineOperatorTool({
    name: spec.name as OperatorToolName,
    requires: grants(spec.requires.map(action => ({ action, scope: spec.scope }))),
    enabled: services => !!services.circleAccounts,
    description: spec.description,
    inputSchema: ciToolInputSchema(spec, 'operator') as StandardSchemaWithJSON,
    outputSchema: spec.outputSchema as StandardSchemaWithJSON,
    annotations: spec.annotations,
    run: (context, input, { extra }) =>
      spec.run(context.services.circleAccounts!, context.principal, input, { signal: extra.mcpReq.signal }),
  })),
  defineOperatorTool({
    name: 'worker_execution_settings_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.workerExecution,
    description: 'Read whether Main permits execution on connected Worker computers; change it with remote_execution_settings_update.',
    detail: 'Explicit environment overrides remain controlled at startup. History, cancellation and cleanup remain available through their existing permissions.',
    inputSchema: z.object({}).strict(),
    outputSchema: WorkerExecutionSettingsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run: async (context) => context.services.workerExecution!.read(context.principal),
  }),
  defineOperatorTool({
    name: 'remote_execution_settings_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.remoteExecution,
    description: 'Read Main’s persisted remote execution and device listener settings, revision, effective values, '
      + 'explicit environment overrides and listener runtime status. Requires global settings:read. '
      + 'TLS file paths refer to Main; certificate and key contents are never returned.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedRemoteExecutionSettingsSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.remoteExecution!.read(context.principal),
  }),
  defineOperatorTool({
    name: 'remote_execution_settings_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.remoteExecution,
    description: 'Replace Main\'s saved remote execution and device listener settings; explicit environment values still override them. Read effective values and restartRequired with remote_execution_settings_get.',
    detail: 'TLS certificate/key paths must name owner-only files owned by Main\'s OS user. Execution enablement applies live. Listener changes apply live when no computers are connected; otherwise restart Main. This grants no device, harness or workflow permissions.',
    inputSchema: RemoteExecutionSettingsUpdateInputSchema, outputSchema: RemoteExecutionSettingsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.remoteExecution!.update(context.principal, 'mcp', input),
  }),
  ...operatorControlTools,
  ...operatorChatTools,
  defineOperatorTool({
    name: 'operator_mcp_setup_get',
    requires: [['harnesses:read', 'global']],
    enabled: s => !!s.operatorChat,
    description: 'Check the Operator\'s Foreman Code MCP installation, endpoint and managed credential, for current defaults or for a conversation (conversationId) or accepted message (requestId). Never installs MCP, issues credentials or proves a per-turn connection.',
    detail: 'configurationVersionId, harness and expectedDefaultsRevision retain the shared setup query checks. Conversation selectors require owner-bound operator_chat:read; private configuration pins require owned history or a live authorized chat binding. Requires global harnesses:read. Native chat-derived callers need a live submitted owner-bound turn and current parent grants. Claude inspects the selected Main or paired Worker profile with read authority and no model input.',
    inputSchema: OperatorChatSetupQuerySchema, outputSchema: OperatorChatSetupSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.operatorChat!.setup(context.principal, input),
  }),
  defineOperatorTool({
    name: 'system_prompt_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.settings,
    description: 'Read the app-wide System prompt and its revision. It is prepended to newly started workflow '
      + 'and Agent chat sessions for Codex and Claude. The Operator is excluded. Requires global settings:read.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedPromptSettingSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getSystemPrompt(context.principal),
  }),
  defineOperatorTool({
    name: 'system_prompt_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.settings,
    description: 'Save the app-wide System prompt for newly started Codex and Claude workflow and Agent chat sessions (empty text clears it; the Operator is excluded). Read back with system_prompt_get.',
    detail: 'Existing sessions keep their saved revision.',
    inputSchema: PromptSettingUpdateInputSchema, outputSchema: PromptSettingUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateSystemPrompt(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'operator_initial_prompt_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.settings,
    description: 'Read the Operator own Initial prompt and revision. Newly created Operator conversations '
      + 'use this text; they do not receive the app-wide System prompt. Requires global settings:read.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedPromptSettingSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getOperatorInitialPrompt(context.principal),
  }),
  defineOperatorTool({
    name: 'operator_initial_prompt_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.settings,
    description: 'Save the Operator\'s own Initial prompt for new conversations (empty text clears it); existing conversations keep their saved revision. Read back with operator_initial_prompt_get.',
    inputSchema: PromptSettingUpdateInputSchema, outputSchema: PromptSettingUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateOperatorInitialPrompt(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'general_settings_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.settings,
    description: 'Read Main’s saved general preferences and revision. Theme is shared by browsers on all computers '
      + 'connected to this Main. Requires global settings:read. Credentials and native profiles remain per computer.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedGeneralSettingsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getGeneralSettings(context.principal),
  }),
  defineOperatorTool({
    name: 'general_settings_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.settings,
    description: 'Save Main\'s general preferences for all connected browsers; read back with general_settings_get. Does not sync database files, credentials or native profiles.',
    inputSchema: GeneralSettingsUpdateInputSchema, outputSchema: GeneralSettingsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateGeneralSettings(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'circle_credit_allowance_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.settings,
    description: 'Read the monthly CircleCI credit allowance per organization and its revision. defaultMonthlyCredits '
      + '(400,000: the CircleCI Free plan grants each organization that for Linux open-source builds) applies to every '
      + 'organization without an entry in accounts, which is keyed by the GitHub owner of the CircleCI org. '
      + 'ci_computers_list and computer_activity_list report each CircleCI org\u2019s remaining credits as this '
      + 'allowance minus that org\u2019s compute usage this month, excluding storage and other charges. This is reporting '
      + 'only; usage reports never block standby eligibility. Credit refusals allow one coordinated recovery probe '
      + 'after five minutes, keeping the replacement active until CircleCI starts the probe job. Exports are sampled at most every '
      + 'three hours; readings are usable for four hours from export window end. Primary and standby orgs '
      + 'have separate usage estimates. Requires global settings:read.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedCircleCreditAllowanceSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getCircleCreditAllowance(context.principal),
  }),
  defineOperatorTool({
    name: 'circle_credit_allowance_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.settings,
    description: 'Replace the monthly CircleCI credit allowance: defaultMonthlyCredits plus per-organization overrides keyed '
      + 'by the GitHub owner of the CircleCI org. This changes reporting only and never blocks CI starts. '
      + 'Requires global settings:update. Omit expectedRevision for last write wins; supply it to reject a stale '
      + 'revision. Reuse commandId with identical input after an uncertain save. Read back with '
      + 'circle_credit_allowance_get; the new total applies to the next ci_computers_list at once. This grants no CI or credential permissions.',
    inputSchema: CircleCreditAllowanceUpdateInputSchema, outputSchema: CircleCreditAllowanceUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateCircleCreditAllowance(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'agent_defaults_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.settings,
    description: 'Read the saved Master, Orchestrator, Worker and Operator defaults that new Agents and new Operator conversations copy, including tools, nativeTools policy and the Operator model, harness, sandbox and effort.',
    detail: 'An omitted Master template uses Orchestrator settings for new Masters. Workflow role graphqlTools are copied only into new Agents: omitted new Master/Orchestrator choices include memory Write, new Worker choices include memory Read; an explicit empty list selects None. Existing Agent configurations retain their original tools. Includes the Operator chat model, harness, Codex or Claude sandbox, effort, and thinking preferences. Unsaved Operator defaults use full access; existing saved settings remain authoritative. New Operator conversations inherit these settings. Operator UI enablement does not disable management MCP.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedAgentDefaultsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getAgentDefaults(context.principal),
  }),
  defineOperatorTool({
    name: 'workflow_defaults_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.workflows && !!s.settings,
    description: 'Read defaults copied into newly created workflows, including user, orchestrator or explicit native harness approval handling. Native handling requires compatible saved settings on each Agent. Graph edges do not grant approval authority.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedWorkflowDefaultsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context) => context.services.settings!.getWorkflowDefaults(context.principal),
  }),
  defineOperatorTool({
    name: 'agent_defaults_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.settings,
    description: 'Replace the role defaults (including the Master template, graphqlTools and nativeTools policy) and the Operator defaults that new Agents and new Operator conversations copy. Existing Agents, running turns and accepted Runs keep their settings.',
    detail: 'Tool choices affect only new Agents; an empty graphqlTools list selects None, and omitted choices use new-role memory defaults (Master/Orchestrator Write, Worker Read). Existing Agents keep their tools and read-only execution restrictions still apply. nativeTools.mcpServers is the native MCP server allowlist ([] = Foreman Code only); nativeTools.apps controls apps/connectors and Claude SDK plugins. Omitted policy fields inherit host settings. Foreman Code stays available under existing grants. These settings are copied into new Agents and pinned into new Operator conversations. Includes the Operator sandbox or permission rules shared by chat and Settings > Agents > Operator. Codex and Claude support explicit danger-full-access. Access choices do not grant app authority or bypass native qualification and approval routing. New conversations inherit Operator changes; running turns and accepted Runs remain pinned. Changing Operator skills, harness, thinking or native-tool settings also requires skills:read in every assigned skill workspace. First local Claude preparation additionally requires harnesses:read and harnesses:update, and runs finite subscription diagnostics for the exact submitted configuration. For HARNESS_PROFILE_SELECTION_CONFLICT, if the selection is stale and the configuration is unchanged, call harness_instances_list and reuse the listed selection (instanceId, instanceRevision, target) and configuration. Only when the configuration must change, call harness_instances_list then harness_instance_save with the intended configuration; reuse the returned selection and configuration in the Agent or defaults write. Saving bumps the profile revision and starts qualification for enabled profiles.',
    inputSchema: AgentDefaultsUpdateInputSchema, outputSchema: AgentDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateAgentDefaults(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'workflow_defaults_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.workflows && !!s.settings,
    description: 'Replace the defaults for future workflows; existing workflows and in-flight approvals do not change. approvalHandler is user, orchestrator or native (native still needs native approval configured on each Agent).',
    detail: 'Native handling preserves each Agent\'s permission rules.',
    inputSchema: WorkflowDefaultsUpdateInputSchema, outputSchema: WorkflowDefaultsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (context, input) => context.services.settings!.updateWorkflowDefaults(context.principal, 'mcp', input),
  }),
]

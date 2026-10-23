import { z } from 'zod'
import { ComputerActivityListSchema, ComputerRenameInputSchema, ComputerRenameResultSchema } from '@foreman-code/contracts/computer-activity'
import { ComputerAccountsListInputSchema, ComputerAccountsListSchema, ComputerSyncReadInputSchema,
  ComputerSyncUpdateInputSchema, ComputerSyncStatusSchema, ComputerGitHubInputSchema,
  ComputerGitHubLogoutInputSchema, ComputerGitHubStatusInputSchema,
  GitHubLoginStateSchema } from '@foreman-code/contracts/computer-accounts'
import { BuildComputerReadSchema, BuildComputerUpdateSchema, BuildComputerStatusSchema,
  BuildComputerBatchUpdateSchema, BuildComputerBatchResultSchema } from '@foreman-code/contracts/build-computers'
import { defineOperatorTool } from '../definition.js'

const writeAnnotations = { readOnlyHint: false, idempotentHint: false, destructiveHint: false, openWorldHint: true }
const annotations = { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false }
export const buildComputerTools = [
  defineOperatorTool({
    name: 'computer_activity_list',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.computerActivity,
    description: 'Read computer presence, running CI Jobs and placed workflow Agent executions, and the cloud CI services Main uses with their current machine counts.',
    detail: 'Failed cloud readiness checks stay visible with observation.lastError and failure counts. Job and agent names are filtered by jobs:read and runs:read scopes. Read-only, at most 101 computers and 200 entries per activity kind; truncated and activityComplete describe coverage. No telemetry permissions are implied; use resource_telemetry tools for utilization.',
    inputSchema: z.object({}).strict(), outputSchema: ComputerActivityListSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    run: (context) => context.services.computerActivity!.list(context.principal, 'mcp'),
  }),
  defineOperatorTool({
    name: 'computer_rename',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.computerActivity,
    description: 'Rename Main or a paired computer (trimmed, 1–60 characters) everywhere computers are listed. Pass target exactly as devices_list or computer_activity_list reports it.',
    detail: 'The name shows in the sidebar, Settings → Computers, CI computer labels and execution-location choices. Last write wins. Read the persisted name back from computer_activity_list.',
    inputSchema: ComputerRenameInputSchema, outputSchema: ComputerRenameResultSchema,
    annotations: { readOnlyHint: false, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    run: (context, input) => context.services.computerActivity!.rename(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'computer_accounts_list',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.computerAccounts,
    description: 'Read which Codex, Claude and GitHub CLI accounts each paired computer has installed and signed in (identities only, never tokens). Pages of 100 computers; pass nextCursor, or target for one installation.',
    detail: 'Results are cached for 30 seconds unless refresh is true; an offline computer reports null accounts. target cannot be combined with cursor. Main appears only on the first page.',
    inputSchema: ComputerAccountsListInputSchema, outputSchema: ComputerAccountsListSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    run: (context, input) => input.target
        ? context.services.computerAccounts!.readTarget(context.principal, 'mcp', input)
        : context.services.computerAccounts!.list(context.principal, 'mcp', input.refresh === true, input.cursor),
  }),
  defineOperatorTool({
    name: 'computer_github_login_start',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.computerGitHub,
    description: 'Start GitHub CLI sign-in on Main or a paired computer; returns a one-time device code for https://github.com/login/device. Follow with computer_github_login_status.',
    detail: 'The owner enters the code in a browser; the token stays on that computer. A pending sign-out finishes before this sign-in starts; a later sign-out cancels a pending start. git-setup-failed means sign-in succeeded but Git setup needs retry.',
    inputSchema: ComputerGitHubInputSchema, outputSchema: GitHubLoginStateSchema, annotations: writeAnnotations,
    run: (context, input) => context.services.computerGitHub!.handle(context.principal, 'mcp', input.target, { operation: 'login-start' }),
  }),
  defineOperatorTool({
    name: 'computer_github_login_status',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.computerGitHub,
    description: 'Read an active GitHub sign-in on that computer: waiting (with its code), signed-in (with the username), '
      + 'git-setup-failed, failed or expired. Requires global settings:update.',
    inputSchema: ComputerGitHubStatusInputSchema, outputSchema: GitHubLoginStateSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    run: (context, input) => context.services.computerGitHub!.handle(context.principal, 'mcp', input.target, { operation: 'login-status', loginId: input.loginId }),
  }),
  defineOperatorTool({
    name: 'computer_github_setup_git',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.computerGitHub,
    description: 'Retry Git credential setup after GitHub sign-in without restarting login. Requires global settings:update. '
      + 'Use the loginId from computer_github_login_status when its state is git-setup-failed.',
    inputSchema: ComputerGitHubStatusInputSchema, outputSchema: GitHubLoginStateSchema, annotations: writeAnnotations,
    run: (context, input) => context.services.computerGitHub!.handle(context.principal, 'mcp', input.target, { operation: 'setup-git', loginId: input.loginId }),
  }),
  defineOperatorTool({
    name: 'computer_github_logout',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.computerGitHub,
    description: 'Remove the expected active GitHub account on a computer and verify the result; read computer_accounts_list first and pass expectedAccount (null only if signed out).',
    detail: 'Reuse the original expectedAccount on uncertain retries; a changed active account causes a conflict without removal. If another saved account becomes active, returns signed-in; unknown status or failed removal returns an error.',
    inputSchema: ComputerGitHubLogoutInputSchema, outputSchema: GitHubLoginStateSchema,
    annotations: { ...writeAnnotations, destructiveHint: true },
    run: (context, input) => context.services.computerGitHub!.handle(context.principal, 'mcp', input.target, { operation: 'logout', expectedAccount: input.expectedAccount }),
  }),
  defineOperatorTool({
    name: 'computer_sync_status',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.computerSync,
    description: 'Read Syncthing shared file status on Main or a paired computer: installed, running, connected peers, '
      + 'workspace participation, enabled preferences and revisions, local folder paths, idle/syncing/error and conflicts. '
      + 'Requires global settings:read. Paths do not grant harness write access.',
    inputSchema: ComputerSyncReadInputSchema, outputSchema: ComputerSyncStatusSchema,
    annotations: { readOnlyHint: true, idempotentHint: true, destructiveHint: false, openWorldHint: false },
    run: (context, input) => context.services.computerSync!.read(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'computer_sync_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.computerSync,
    description: 'Enable or disable one workspace shared folder on one computer. Disabling keeps local files; read saved preferences with computer_sync_status.',
    detail: 'Syncthing installs automatically, pairs through the app and uses Tailscale with Main as hub and simple versioning. Only computers selected for workspace Agents receive the folder; enabled preferences apply when they participate. Unavailable enabled peers defer folder replacement; saved preferences retry when they reconnect. Main off stops sharing through the hub.',
    inputSchema: ComputerSyncUpdateInputSchema, outputSchema: ComputerSyncStatusSchema,
    annotations: { ...writeAnnotations, idempotentHint: true },
    run: (context, input) => context.services.computerSync!.update(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'build_computer_get',
    requires: [['settings:read', 'global']],
    enabled: s => !!s.buildComputers,
    description: 'Read the saved build participation, priority, allowance and revision of Main or a paired computer, with its derived build readiness and the reasons it is not ready.',
    detail: 'New paired computers default to enabled builds, priority 50 and allowance 100. Re-pairing refreshes the target identity and advances the revision while preserving saved choices, including disabled builds. Readiness uses Job admission capacity, saved build allowance and fresh remote available memory; reasons distinguish reserved capacity, unavailable memory, insufficient memory and an allowance too small for the runtime. Pairing approves product-managed root setup; runtime qualification and the Main startup execution gate remain separate.',
    inputSchema: BuildComputerReadSchema, outputSchema: BuildComputerStatusSchema, annotations,
    run: (context, input) => context.services.buildComputers!.read(context.principal, input, 'mcp'),
  }),
  defineOperatorTool({
    name: 'build_computer_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.buildComputers,
    description: 'Revision-check and save one computer\'s build participation, priority (0–100, highest tried first after a preferred computer) and build allowance (10–100 percent of its CPU and memory; omit to keep). Affects future launches only.',
    detail: 'Running Jobs retain cancellation/recovery and artifacts. commandId is optional and generated server-side when omitted. Does not install, pair, approve a runtime or enable the Main startup execution gate.',
    inputSchema: BuildComputerUpdateSchema, outputSchema: BuildComputerStatusSchema,
    annotations: { ...annotations, readOnlyHint: false },
    run: (context, input) => context.services.buildComputers!.update(context.principal, 'mcp', input),
  }),
  defineOperatorTool({
    name: 'build_computers_update',
    requires: [['settings:update', 'global']],
    enabled: s => !!s.buildComputers,
    description: 'Atomically update build participation, priority and allowance for several computers, checking every expectedRevision before changing any. Affects future placement only.',
    detail: 'commandId is optional and generated server-side when omitted; a replay returns the original result. Read build_computer_get afterwards for current settings. Running Jobs keep their computer.',
    inputSchema: BuildComputerBatchUpdateSchema, outputSchema: BuildComputerBatchResultSchema,
    annotations: { ...annotations, readOnlyHint: false },
    run: (context, input) => context.services.buildComputers!.updateBatch(context.principal, 'mcp', input),
  }),
]

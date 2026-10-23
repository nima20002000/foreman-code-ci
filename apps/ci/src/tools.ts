// CI's MCP tools as transport-neutral specs: the host registers them with its own MCP server, results and audit.
// Names, descriptions, schemas and annotations are the tool contract; keep them byte-identical when moving code.
import { CiRunInputSchema, OperatorCiRunInputSchema, CiRunOutputSchema,
  CiGetInputSchema, OperatorCiGetInputSchema, CiGetOutputSchema,
  CiCancelInputSchema, OperatorCiCancelInputSchema, CiCancelOutputSchema,
  CI_LOG_MAX_BYTES, CiLogsInputSchema, OperatorCiLogsInputSchema, CiLogsOutputSchema, CiComputersOutputSchema,
  OperatorCiListInputSchema, CiListOutputSchema, BuildComputerPrepareGetInputSchema, BuildComputerPrepareInputSchema,
  BuildComputerPrepareStatusSchema, CiEnrollmentReadSchema, CiEnrollmentUpdateSchema, CiEnrollmentStateSchema } from '@foreman-code/contracts'
import {
  CircleAccountAddInputSchema, CircleAccountRemoveInputSchema, ManagedCircleAccountsSchema, CircleAccountsUpdateResultSchema,
  type ManagementAction, type ManagementPrincipal,
} from '@foreman-code/contracts/management'
import { z } from 'zod'
import { CI_GET_ACTIONS, CI_RUN_ACTIONS } from './authority.js'
import type { CiTicketClient } from './client.js'
import type { CircleAccountsManagementService } from './circleAccountsManagement.js'
import { CI_ENROLLMENT_ACTIONS, type CiEnrollment } from './ciEnrollment.js'
import { BUILD_COMPUTER_PREPARE_ACTIONS, type CiRuntimeProvisioner } from './ciRuntimeProvisioner.js'

/** A zod schema, or its Standard Schema view (`{ '~standard': schema['~standard'] }`). */
export type CiToolSchema = Pick<z.ZodType, '~standard'>
type Output<S extends CiToolSchema> = NonNullable<S['~standard']['types']>['output']
export type CiToolAudience = ManagementPrincipal['audience']
export interface CiToolAnnotations {
  readOnlyHint?: boolean; destructiveHint?: boolean; idempotentHint?: boolean; openWorldHint?: boolean
}
/** One CI tool. `requires` are every grant a caller needs, checked in `scope` (any workspace, or globally). */
export interface CiToolSpec<Service> {
  name: string
  requires: readonly ManagementAction[]
  scope: 'workspace' | 'global'
  /** Only the Operator sees the tool. */
  operatorOnly?: true
  description: string
  /** operator_get_capabilities detail; omitted, the host uses its default text. */
  detail?: string
  inputSchema: CiToolSchema | ((audience: CiToolAudience) => CiToolSchema)
  outputSchema: CiToolSchema
  annotations: CiToolAnnotations
  run(service: Service, principal: ManagementPrincipal, input: unknown, options: { signal: AbortSignal }): Promise<unknown>
}
function tool<Service, Schema extends CiToolSchema>(spec: Omit<CiToolSpec<Service>, 'inputSchema' | 'run'> & {
  inputSchema: Schema | ((audience: CiToolAudience) => Schema)
  run(service: Service, principal: ManagementPrincipal, input: Output<Schema>, options: { signal: AbortSignal }): Promise<unknown>
}): CiToolSpec<Service> { return spec }
/** The schema a principal of this audience sees. */
export function ciToolInputSchema(spec: CiToolSpec<unknown>, audience: CiToolAudience): CiToolSchema {
  return typeof spec.inputSchema === 'function' ? spec.inputSchema(audience) : spec.inputSchema
}

/** What each CI tool does. Agents act on this text, so keep it short and true to the code. */
export const CI_TOOL_DESCRIPTIONS = {
  ci_run: 'Run one suite (install, typecheck, lint, unit, build or integration) of the workspace GitHub repository on '
    + 'build computers and cloud runners. Enabled idle build computers pre-warm queued commits offline in persistent '
    + 'checkouts without holding CI slots; real CI takes priority. Commit: the given one; otherwise an Agent\u2019s edited files (published to GitHub '
    + 'first, snapshot up to 32 MiB) or its Run-start commit; otherwise the default branch head. scope defaults to affected: '
    + 'the files you pass, or the files changed since baseCommit (a full SHA ancestor) or since the merge-base with the '
    + 'default branch. Integration uses ancestor execution coverage with conservative static fallbacks; '
    + 'infrastructure changes run everything. ci_run returns the initial selection; ci_get run.selection '
    + 'retains the runner selection and its coverage commit or fallback reason. '
    + 'Repositories without affected test selection default to full when scope and files are omitted. '
    + 'Explicit scope=affected or files on those repositories fails with CI_SELECTION_UNSUPPORTED (409); '
    + 'request scope=full and omit files. '
    + 'scope=full runs everything. After test failures, rerun only the failed test files: scope=affected, '
    + 'files=ci_get.failedFiles (or paths from testStatus=[failed] / failureHistory), with an explicit commit and the same suite. '
    + 'For multi-suite gates, separate failed files by suite. '
    + 'Repositories without affected test selection must rerun with scope=full and no files. '
    + 'Integration splits into parts of about four minutes of measured test time; omit '
    + 'partitions to let CI size them (2\u201364 caps the count). Slow integration files start after the fast tier passes. '
    + 'Affected unit/integration runs with explicit files reuse matching results from earlier passed tickets (cachedFiles), '
    + 'including unchanged files on the same commit; full runs bypass this cache. '
    + 'gate=true (Operators only; integration, scope full, no files or partitions) runs typecheck, lint, unit and '
    + 'integration across every computer; one gate runs at a time. priority is normal or high. A newer descendant commit '
    + 'from the same requester on the same branch or Agent execution cancels its older active tickets of the same suite '
    + 'unless noSupersede=true; ci_get then reports supersededBy. commandId is optional; repeating it with the same input '
    + 'returns the original tickets. An identical request (same workspace, repository, commit, suite, scope, baseCommit, '
    + 'files, partitions and gate) made while one is queued or running joins it instead of queueing new tickets: it returns '
    + 'the same tickets with joined=true and sharedWith (other requesters still attached), and every requester reads the '
    + 'same result. Joining needs the same CI grants as a new request. Returns ticketId and, for multi-part runs, '
    + 'partitions: wait for the group with one ci_get waitUntil=group-terminal call on any ticket, not by polling.',
  ci_get: 'Read one CI ticket. reassignment retains its cause, previous host, time and cumulative count. '
    + 'mirrorPublication.repair retains clone repair cause, source, duration and count. '
    + 'observation reports whether live state is available, its last successful read, '
    + 'sanitized lastError, consecutiveFailures and nextAttemptAt. Retained state is not a confirmed live observation. '
    + 'transport reports REST/CLI source, fallback reason and count when available. '
    + 'State (queued, starting, running, passed, failed, canceled, lost), step, computer, part '
    + 'and shard, exit code, message, a 32 KiB log tail, its group\u2019s partitions and group state, queue position and '
    + 'reason while queued, expectedDurationMs, cachedFiles, and supersededBy (follow the replacement ticket and its '
    + 'partitions). Gate tickets add per-computer and per-suite expected and actual durations. testStatus (passed, failed, '
    + 'skipped) adds structured test results, each failure with its message and path:line:column. A failed group adds '
    + 'failedFiles across all parts, independent of testStatus; an empty list means no failed test files were reported. '
    + 'Rerun only failed files with ci_run scope=affected, files=failedFiles, an explicit commit and the same suite '
    + '(separate files by suite for multi-suite gates). Repositories without affected test selection require scope=full '
    + 'and no files. testStatus=[failed] and failureHistory also name failed files. '
    + 'Explicit affected unit/integration selections reuse matching results from earlier passed tickets, including unchanged '
    + 'files on the same commit (cachedFiles); full runs bypass this cache. A background dispatcher '
    + 'refreshes healthy state about every second; unavailable observations use bounded backoff. To wait, make one call '
    + 'with waitUntil=group-terminal, waitSeconds=1800 and logTail=false on any ticket of the group instead of polling: '
    + 'it returns wait.status settled once every ticket of the group is terminal and its results are collected '
    + '(partitions then lists each final ticket), or still-running with tickets and settledTickets when the budget ends; '
    + 'call again to keep waiting. The managed bridge holds the call open across bounded chunks; a direct HTTP call '
    + 'answers within 60 seconds. Read logs once at the end with ci_logs_read. Without waitUntil, waitSeconds waits at '
    + 'most 60 seconds for this ticket’s state or step to change or a terminal state; request cancellation '
    + 'ends any wait. A part fails after 180 seconds without output or after '
    + 'max(3 \u00d7 expectedDurationMs, 120 seconds); a cloud part that fails before its first test is retried once on another '
    + 'slot (setupRetry). A failed ticket adds failureHistory: how many of the latest gate runs that ran each failed '
    + 'test also failed it, so a known flake is recognized. sharing lists every requester (principalId, executionId, '
    + 'initiator, active) when identical requests joined the group. Agents with ci_get read every ticket of their workspace. '
    + 'Malformed or unknown ticketId returns CI_RUN_NOT_FOUND with up to five recent groups you requested or joined, '
    + 'scoped to your execution when present, '
    + 'in the message and details.recentTickets (lead ticketId, suite, scope, group state, createdAt in UTC).',
  ci_computers_list: 'CircleCI rows retain account as the GitHub org owner and use circleAccountId for the login; '
    + 'schedulingRole reports active, standby or exhausted independently of authentication readiness. '
    + 'Estimated usage is sampled at most every three hours, usable for four hours from export window end; '
    + 'Only an explicit CircleCI credit refusal exhausts an org. Usage reports never block standby eligibility. '
    + 'After five minutes, creditProbeAvailable permits one coordinated recovery build while the replacement '
    + 'remains active. Normal admission resumes only after CircleCI starts that probe job. '
    + 'List the computers CI can use: readiness and its reasons (GitHub login, git, corepack, user '
    + 'systemd), saved buildAllowancePercent, allowedCpuCount, CPU and memory within that allowance, '
    + 'used and total CI slots, available memory, running tickets, and up to 500 queued tickets with priority, '
    + 'queue position and reason (queueTruncated reports more). Read participation and priority with build_computer_get. '
    + 'CircleCI entries add credits {total, used, remaining, asOf}: an estimate of that one org\u2019s credits left this '
    + 'month for compute reporting only, its configured monthly allowance (circle_credit_allowance_get/update; default 400,000, the Free plan\u2019s '
    + 'open-source Linux credits per org) minus the org\u2019s compute usage (excluding storage and other charges), or '
    + 'credits=null with creditsUnavailable when that org\u2019s read failed. '
    + 'Each further CircleCI org is its own set of cloud slots (hostRef.account names its GitHub owner); Main adds one '
    + 'by itself once that GitHub organization has a copy of the CI mirror followed in CircleCI, which is set up '
    + 'outside Foreman (docs/runbooks/add-circleci-org.md).',
  ci_cancel: 'Cancel a queued or running CI ticket by ticketId. Optional commandId is recorded once in the audit, so a '
    + 'retry is safe. CI_CANCEL_PENDING means remote cleanup is unconfirmed and still retrying. A requester of a group '
    + 'that joined identical requests share only detaches (detached.remainingRequesters) while others remain; the '
    + 'tickets are canceled once no requester remains. run_stop cancels every open ticket of that Run\u2019s Agents '
    + 'that no other requester still shares. Malformed or unknown ticketId returns CI_RUN_NOT_FOUND with your recent '
    + 'tickets in the message and details.recentTickets.',
  ci_logs_read: 'Read a CI ticket\u2019s log from its computer, or its labeled saved tail on Main when the completed '
    + `executor is unavailable. Omit afterOffset for the last maxBytes (at most ${CI_LOG_MAX_BYTES}), `
    + 'source=saved-tail uses byte cursors within that saved snapshot; restart at 0 when source changes, '
    + 'or page forward with nextOffset. group=true pages every part of the ticket\u2019s group within the same budget. '
    + 'Queued tickets return CI_NOT_STARTED. Malformed or unknown ticketId returns CI_RUN_NOT_FOUND with up to five '
    + 'recent groups you requested or joined, '
    + 'scoped to your execution when present, in the message and details.recentTickets '
    + '(lead ticketId, suite, scope, group state, createdAt in UTC). '
    + 'Saved tails expire with confirmed executor cleanup after three days, keeping the newest 200 tickets per computer. '
    + 'Ticket results and history remain available.',
  ci_list: 'List CI tickets the Agents of one Run requested or joined as identical requests, newest first (at most 500). '
    + 'Optional executionId filters before the limit. Each ticket includes suite, part, '
    + 'partition, scope, state, step, computer and placement (host, github or circleci), timing, the requesting '
    + 'Agent\u2019s executionId, agentId and workflow node, and passed/failed/skipped test counts once reported. '
    + 'Read a ticket\u2019s tests with ci_get testStatus and its log with ci_logs_read. Requires runs:read on the Run.',
} as const

const read = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false }
const operator = (audience: CiToolAudience) => audience === 'operator'
/** Host CI tools, in registration order. Agents see every tool but ci_list, with their own input schemas. */
export const CI_TOOL_SPECS: readonly CiToolSpec<CiTicketClient>[] = [
  tool({
    name: 'ci_run', requires: CI_RUN_ACTIONS, scope: 'workspace',
    description: CI_TOOL_DESCRIPTIONS.ci_run, detail: CI_TOOL_DESCRIPTIONS.ci_run,
    inputSchema: audience => operator(audience) ? OperatorCiRunInputSchema : CiRunInputSchema,
    outputSchema: CiRunOutputSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
    run: (ci, principal, input) => ci.run(principal, input),
  }),
  tool({
    name: 'ci_get', requires: CI_GET_ACTIONS, scope: 'workspace',
    description: CI_TOOL_DESCRIPTIONS.ci_get, detail: CI_TOOL_DESCRIPTIONS.ci_get,
    inputSchema: audience => operator(audience) ? OperatorCiGetInputSchema : CiGetInputSchema,
    outputSchema: CiGetOutputSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (ci, principal, input, { signal }) => ci.get(principal, input, signal),
  }),
  tool({
    name: 'ci_computers_list', requires: CI_GET_ACTIONS, scope: 'workspace',
    description: CI_TOOL_DESCRIPTIONS.ci_computers_list, detail: CI_TOOL_DESCRIPTIONS.ci_computers_list,
    inputSchema: audience => operator(audience) ? OperatorCiGetInputSchema.pick({ workspaceId: true }) : z.object({}).strict(),
    outputSchema: CiComputersOutputSchema, annotations: read,
    run: (ci, principal, input) => ci.computers(principal, input),
  }),
  tool({
    name: 'ci_cancel', requires: CI_RUN_ACTIONS, scope: 'workspace',
    description: CI_TOOL_DESCRIPTIONS.ci_cancel, detail: CI_TOOL_DESCRIPTIONS.ci_cancel,
    inputSchema: audience => operator(audience) ? OperatorCiCancelInputSchema : CiCancelInputSchema,
    outputSchema: CiCancelOutputSchema,
    annotations: { ...read, readOnlyHint: false, destructiveHint: true },
    run: (ci, principal, input) => ci.cancel(principal, input),
  }),
  tool({
    name: 'ci_logs_read', requires: CI_GET_ACTIONS, scope: 'workspace',
    description: CI_TOOL_DESCRIPTIONS.ci_logs_read, detail: CI_TOOL_DESCRIPTIONS.ci_logs_read,
    inputSchema: audience => operator(audience) ? OperatorCiLogsInputSchema : CiLogsInputSchema,
    outputSchema: CiLogsOutputSchema, annotations: read,
    run: (ci, principal, input) => ci.logs(principal, input),
  }),
  // A Run's whole CI list is for the Operator; Agents read workspace tickets with ci_get.
  tool({
    name: 'ci_list', requires: [...CI_GET_ACTIONS, 'runs:read'], scope: 'workspace', operatorOnly: true,
    description: CI_TOOL_DESCRIPTIONS.ci_list, detail: CI_TOOL_DESCRIPTIONS.ci_list,
    inputSchema: OperatorCiListInputSchema, outputSchema: CiListOutputSchema, annotations: read,
    run: (ci, principal, input) => ci.list(principal, input),
  }),
]

/** CircleCI login settings; Operator only. */
export const CIRCLE_ACCOUNT_TOOL_SPECS: readonly CiToolSpec<CircleAccountsManagementService>[] = [
  tool({
    name: 'circle_accounts_list', requires: ['settings:read'], scope: 'global', operatorOnly: true,
    description: 'Read primary and standby CircleCI logins, organization status, observed authentication/readiness, '
      + 'per-org scheduling role and estimated credits from the dispatch fleet. organizations contains saved bindings; '
      + 'orgs includes automatically discovered primary organizations. Usage exports are sampled at most '
      + 'every three hours and readings are usable for four hours from their export window end. '
      + 'Local human setup provisions API tokens in private CLI profiles outside Foreman; no credentials are returned.',
    inputSchema: z.object({}).strict(), outputSchema: ManagedCircleAccountsSchema,
    annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (service, principal) => service.get(principal),
  }),
  tool({
    name: 'circle_account_add', requires: ['settings:update'], scope: 'global', operatorOnly: true,
    description: 'Register or update nonsecret CircleCI account metadata: one stable default primary login and '
      + 'one second login, each with three distinct GitHub org owners. A second login with role primary takes CI jobs '
      + 'alongside the default login; role standby waits until CircleCI refuses a primary org for credits. '
      + 'An omitted role defaults to standby. '
      + 'Missing local credentials do not prevent registration. Local human setup provisions the token outside '
      + 'Foreman. No token argument is accepted. Omit expectedRevision for last write wins or supply it to reject '
      + 'stale metadata; reuse commandId with identical input after an uncertain save. Read back with circle_accounts_list.',
    // Retain strict validation so an accidental credential argument is rejected before command persistence.
    inputSchema: { '~standard': CircleAccountAddInputSchema['~standard'] }, outputSchema: CircleAccountsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    run: (service, principal, input) => service.add(principal, 'mcp', input),
  }),
  tool({
    name: 'circle_account_remove', requires: ['settings:update'], scope: 'global', operatorOnly: true,
    description: 'Remove the standby CircleCI registration after assigned jobs and result collection settle. '
      + 'The default primary identity cannot be removed. Historical records and private CLI profiles remain; '
      + 'local human cleanup revokes the token separately. Optional expectedRevision rejects stale metadata; '
      + 'commandId supports identical retries. Read back with circle_accounts_list.',
    inputSchema: { '~standard': CircleAccountRemoveInputSchema['~standard'] }, outputSchema: CircleAccountsUpdateResultSchema,
    annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: false },
    run: (service, principal, input) => service.remove(principal, 'mcp', input),
  }),
]

const runtimeRead = { readOnlyHint: true, idempotentHint: true, openWorldHint: false }
const runtimeWrite = { readOnlyHint: false, idempotentHint: true, openWorldHint: false }
const enrollmentGetDetail = 'Read per-computer workspace CI enrollment, persisted disable choices and per-template results, '
  + 'including executionMode. Host CI reports runner readiness without runtime profiles or preparation. '
  + 'Globally disabled builds report how to enable them with build_computer_update. '
  + 'Protected runtime results include pairing-managed setup and migration status, missing workspace profiles '
  + '(templates-required), '
  + 'storage availability, preparation failures '
  + 'and ordinary templates not enrolled automatically.'
const enrollmentUpdateDetail = 'Enable, retry or disable workspace CI enrollment with revision checks and idempotent commands. '
  + 'commandId is optional and generated server-side when omitted. '
  + 'Host CI checks runner readiness without preparing legacy runtimes; globally disabled builds remain disabled. '
  + 'For protected runtimes, enabling adopts pairing-approved product-managed storage and binds a writable root, '
  + 'preserves verification templates’ resource envelopes and prepares installed runtimes. Arbitrary user paths '
  + 'require explicit root approval. Insufficient storage and ordinary templates are reported without automatic enrollment.'
/** Workspace CI enrollment of build computers; Operator only. */
export const CI_ENROLLMENT_TOOL_SPECS: readonly CiToolSpec<CiEnrollment>[] = [
  tool({
    name: 'ci_enrollment_get', requires: ['job_definitions:read'], scope: 'workspace', operatorOnly: true,
    detail: enrollmentGetDetail,
    description: enrollmentGetDetail
      + ' Protected runtimes without active profiles report templates-required; save a verification profile with '
      + 'job_runtime_profile_save. Failed protected preparations use exponential backoff capped at one hour. '
      + 'Reads do not install, prepare or qualify runtimes. Requires job_definitions:read.',
    inputSchema: CiEnrollmentReadSchema, outputSchema: CiEnrollmentStateSchema, annotations: runtimeRead,
    run: (enrollment, principal, input) => enrollment.read(principal, input),
  }),
  tool({
    name: 'ci_enrollment_update', requires: CI_ENROLLMENT_ACTIONS, scope: 'workspace', operatorOnly: true,
    detail: enrollmentUpdateDetail,
    description: enrollmentUpdateDetail
      + ' Read ci_enrollment_get for persisted results. Requires build_computer_prepare grants plus '
      + 'workspace_locations:validate/update. Build participation is a separate global setting controlled by '
      + 'build_computer_update; enabling workspace enrollment does not change it. Host CI uses ci_run.',
    inputSchema: CiEnrollmentUpdateSchema, outputSchema: CiEnrollmentStateSchema,
    annotations: { ...runtimeWrite, openWorldHint: true },
    run: (enrollment, principal, input) => enrollment.update(principal, 'mcp', input),
  }),
]

/** Main's legacy CI runtime preparation; Operator only. build_computer_prepare_get uses the host's default detail. */
export const COMPUTER_PREPARATION_TOOL_SPECS: readonly CiToolSpec<CiRuntimeProvisioner>[] = [
  tool({
    name: 'build_computer_prepare', requires: [...BUILD_COMPUTER_PREPARE_ACTIONS], scope: 'workspace', operatorOnly: true,
    detail: 'Prepare and refresh Main’s legacy CI runtime using approved workspace roots. '
  + 'commandId is optional and generated server-side when omitted. '
  + 'Paired Workers use Host CI through ci_run and reject legacy runtime refresh. '
  + 'Requires all preparation grants; installer paths are selected by the installed runtime.',
    description: 'Prepare Main\'s legacy CI runtime for a commit once it has an installed CI runtime (default: the workspace repository\'s default branch). Paired Workers use Host CI through ci_run and reject legacy runtime refresh. The computer fetches the commit from the workspace GitHub repository, builds its offline package seed and verification image (or reuses its existing image when the commit\'s dependency inputs and installed runtime controls are unchanged; a still-ready qualification of that same image is kept without requalifying), Main moves every verification profile on that computer to the commit and image, Main refreshes its protected runtime, restarts itself and resumes the preparation, and Main requalifies each profile. Runs in the background; follow it with build_computer_prepare_get. One preparation per physical computer across workspaces. Image builds use at most half the computer CPUs and memory; preparationLimits reports those caps. Current registration and build settings are rechecked before admission and each background step; revoked or changed registrations stop preparation and retain its failed status. A different command while one runs reports CI_RUNTIME_BUSY; retry it later. The same command resumes or reads its persisted operation after Main restarts. Requires job_definitions:read, job_definitions:write, sources:approve, sources:read, source_roots:bind, source_roots:read, workspace_locations:read, jobs:start and job_artifacts:read in the workspace.',
    inputSchema: BuildComputerPrepareInputSchema, outputSchema: BuildComputerPrepareStatusSchema,
    annotations: { ...runtimeWrite, openWorldHint: true },
    run: (ci, principal, input) => ci.start(principal, 'mcp', input),
  }),
  tool({
    name: 'build_computer_prepare_get', requires: ['job_definitions:read'], scope: 'workspace', operatorOnly: true,
    description: 'Read the CI runtime preparation of the computer that holds this verification profile: approving, preparing (with its build stage), binding, refreshing, qualifying, qualified or failed (with the reason), each profile\'s revision and status, and whether the image and qualification were reused (with the source commit of the reused qualification). Includes preparationLimits (CPU count and memory bytes) and cache status, lastError, missCount and rebuildCount for this preparation. Includes consecutive failureCount and retryAt; automatic enrollment waits until retryAt before retrying, with exponential backoff capped at one hour. Explicit preparation commands can retry immediately. Repository captures of the same workspace, commit, location and tracked inventory are reused while retained. Reads persisted progress across Main restarts; idle when this workspace has no preparation for the computer. Requires job_definitions:read.',
    inputSchema: BuildComputerPrepareGetInputSchema, outputSchema: BuildComputerPrepareStatusSchema, annotations: runtimeRead,
    run: (ci, principal, input) => ci.get(principal, input),
  }),
]

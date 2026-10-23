import type { AcceptedProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { createClaudeFileCallResolver } from '../../files/claude/callResolver.js'
import { createClaudeFileMcpServer, type ClaudeFileSdk } from '../../files/claude/server.js'
import type { AgentFileToolService } from '../../files/tools/service.js'
import { productionClaudeFileAdmission } from './fileProduction.js'
import type pg from 'pg'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import type { NativeSessionReference, CoordinatorConsultationBinding } from '@foreman-code/contracts'
import { APP_MCP_TOKEN_NAMES } from '@foreman-code/contracts/product'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { appMcpServerName, isSupportedAppMcpServerName } from '../appMcpLauncher.js'
import { DomainError } from '../../errors.js'
import { admitWhenChecked } from '../instanceSettings/profileCheckWait.js'
import type { NativeHarnessFactories } from '../runtimeFactory.js'
import type { NativeProcessRecovery } from '../recovery/processRegistry.js'
import type { NativeSessionStart } from '../port.js'
import { hasWorkflowRequest } from '../sessionStart.js'
import type { ProductionHarnessRegistry } from '../productionRegistry.js'
import type { AcceptedClaudeProfileAdmission, AcceptedProfileSelector } from '../instanceSettings/acceptedProfile.js'
import { ClaudeInputNotDeliveredError, type ClaudeSdkClient } from './port.js'
import { compileClaudeConfiguration } from './configuration.js'
import { createPostgresClaudeInteractionBridge, type ClaudeDomainBinding } from './domainAuthority.js'
import { createClaudeSdkCallbacks } from './sdkCallbacks.js'
import { createClaudeSdkRunner } from './runner.js'
import { loadOfficialClaudeSdk } from './official.js'
import { acceptedClaudeAppTools } from './mcpPolicy.js'
import type { ClaudeInteractionBridge } from './interactions.js'
import { claudeProductionMcpInspector } from './productionMcpInspector.js'
import type { ClaudeNativeSessionManager } from './sessionManager.js'
import type { OperatorProfileObservation } from '../operatorProfileObservation.js'
import type { ProviderAccountResolver } from '../../provider-accounts/service.js'
import { assertRuntimeProviderAccountProfile, resolveRuntimeProviderAccount } from '../providerAccountRuntime.js'
import { requireClaudeApiKey } from './productionCredentials.js'
import { assertConsultationRebind } from '../consultationSession.js'
import { hostEnvironment } from '../../../shared/process.js'

/** Private lifetime signal is never serialized into accepted configuration or provenance. */
export type ClaudeProfileOwner = (ClaudeDomainBinding | OperatorProfileObservation | {
  /** Read-only setup has no conversation, accepted input or SDK callbacks. */
  kind: 'operator-inspection'; principalId: string; configurationVersionId: string; configurationHash: string
}) & { admissionSignal?: AbortSignal; purpose?: 'reviewer' | 'consultation'; consultation?: CoordinatorConsultationBinding }

/** The role's immutable configuration/placement supplies the selector; the
 * existing admission reads its exact profile and current native proof. */
interface ProductionClaudeInput {
  pool: pg.Pool
  factories: NativeHarnessFactories
  registry: ProductionHarnessRegistry
  profiles?: AcceptedClaudeProfileAdmission<ClaudeProfileOwner>
  selector?: AcceptedProfileSelector
  binding: ClaudeDomainBinding
  consultation?: CoordinatorConsultationBinding
  role: 'workflow' | 'operator' | 'agent-chat'
  configuration: ClaudeHarnessConfiguration
  /** Privately provisioned for this accepted profile; never inherited from host authentication. */
  apiKey?: string
  accounts?: ProviderAccountResolver
  workingDirectory: string
  ownerAgentId: string
  recovery: NativeProcessRecovery
  accountSourceRecovery?: NativeProcessRecovery
  accountBinding?: AcceptedProviderAccountBinding
  appMcpAccess: 'scoped' | 'none'
  inspectionStart(): Promise<NativeSessionStart>
  mode: 'native' | 'replay'
  files?: { service(): AgentFileToolService; sdk?: () => Promise<ClaudeFileSdk> }
  loadClient?: (input: { profilePath: string; recovery: NativeProcessRecovery; binary: string }) => Promise<ClaudeSdkClient>
}

/** The role must match its actual domain owner; the caller's mutable settings are copied. */
function ownedClaudeInput(input: ProductionClaudeInput): ProductionClaudeInput {
  if (input.role === 'workflow' && input.binding.kind !== 'workflow'
    || input.role === 'operator' && input.binding.kind !== 'operator'
    || input.role === 'agent-chat' && input.binding.kind !== 'agent') throw new DomainError('CLAUDE_OWNER_MISMATCH',
    'The Claude runtime role must match its actual domain owner.', 409)
  return { ...input, configuration: structuredClone(input.configuration),
    ...(input.accountBinding ? { accountBinding: structuredClone(input.accountBinding) } : {}),
    ...(input.selector ? { selector: structuredClone(input.selector) } : {}) }
}

function setControlPrincipal(binding: ClaudeDomainBinding, principalId: string): void {
  if (binding.kind === 'operator' || binding.kind === 'agent') binding.controlPrincipalId = principalId
}

/** The conversation's MCP servers with its scoped credential as the Foreman server's HTTP header. */
function conversationCredentialServers(start: NativeSessionStart) {
  if ((start.kind !== 'operator' && start.kind !== 'agent-chat') || start.configuration.harness.harness !== 'claude') {
    throw new DomainError('HARNESS_ROLE_AUTHORITY_INVALID', 'Credential rebinding requires the accepted Claude conversation.', 403)
  }
  const servers = start.configuration.harness.mcpServers
  const serverName = appMcpServerName(servers)
  const configured = servers[serverName]
  const token = readProductEnvironment(start.environment?.variables ?? {}, 'MCP_TOKEN')
  if (configured?.type !== 'http' || !token) {
    throw new DomainError('OPERATOR_MCP_SETUP_REQUIRED', 'The accepted HTTP credential arrangement is unavailable.', 409)
  }
  return { ...servers, [serverName]: { ...configured, headers: { Authorization: `Bearer ${token}` } } }
}

function bindConversationCredentialRefresh(manager: ClaudeNativeSessionManager) {
  manager.rebindApplicationAccess = async (session, start, signal) => {
    await manager.refreshSessionCredentials(session, start, conversationCredentialServers(start), signal)
  }
}

/** An Agent chat's token arrives only in its launch environment, but Claude's HTTP MCP client needs it as a header.
 * Deliver it on the inspected query before the first native input (fresh, forked Run follow-up or resumed chat);
 * the resumed query re-applies it and later rollovers keep it. */
function bindAgentChatCredentialDelivery(manager: ClaudeNativeSessionManager) {
  let delivered = false
  const deliver = async (start: NativeSessionStart, signal?: AbortSignal) => {
    if (delivered) return
    const servers = conversationCredentialServers(start)
    await manager.prepareInspection(start, signal)
    await manager.refreshInspectionCredentials(start, servers, signal)
    delivered = true
  }
  const initial = manager.startInitialTurn.bind(manager)
  manager.startInitialTurn = async function* (start, input, signal) {
    await deliver(start, signal)
    yield* initial(start, input, signal)
  }
  const attach = manager.attachSession.bind(manager)
  manager.attachSession = async (session, start, signal) => {
    if (!manager.hasResidentSession(session)) await deliver(start, signal)
    return attach(session, start, signal)
  }
  if (manager.forkSession) {
    const fork = manager.forkSession.bind(manager)
    manager.forkSession = async (source, start, signal) => {
      await deliver(start, signal)
      return fork(source, start, signal)
    }
  }
}

function bindConsultationAccess(manager: ClaudeNativeSessionManager,
  domain: ReturnType<typeof createPostgresClaudeInteractionBridge>,
  getStart: () => NativeSessionStart | undefined, setStart: (start: NativeSessionStart) => void): void {
  const rebind = manager.rebindApplicationAccess?.bind(manager)
  manager.rebindApplicationAccess = async (session, start, effectSignal) => {
    if (!rebind) throw new DomainError('NATIVE_CREDENTIAL_REBIND_UNAVAILABLE',
      'This native manager cannot change its application subject.', 409)
    const sessionStart = getStart()
    if (!sessionStart) throw new DomainError('CLAUDE_SESSION_CONTEXT_REQUIRED',
      'The rebind requires its admitted native session context.', 409)
    assertConsultationRebind(sessionStart, start, session)
    const domainBinding = domain.authority.binding
    const previous = domainBinding.kind === 'workflow' ? domainBinding.consultation : undefined
    await domain.authority.rebindConsultation(start.kind === 'workflow-consultation' ? start.consultation : undefined)
    try { await rebind(session, start, effectSignal) }
    catch (error) {
      // Restore the previous domain only; failed native credential delivery remains a hard error.
      if (domainBinding.kind === 'workflow') {
        if (previous) domainBinding.consultation = previous
        else delete domainBinding.consultation
      }
      throw error
    }
    setStart(start)
  }

}

function assertNoInheritedAppMcpToken(input: ProductionClaudeInput, start: NativeSessionStart): void {
  if (input.appMcpAccess === 'none' && APP_MCP_TOKEN_NAMES.some((name) => start.environment?.variables[name])) throw new DomainError('HARNESS_ROLE_AUTHORITY_INVALID',
    'This Claude owner cannot inherit an application MCP credential.', 403)
}

async function workflowApprovalHandler(input: ProductionClaudeInput): Promise<string | null | undefined> {
  if (input.binding.kind !== 'workflow') return undefined
  return (await input.pool.query<{ handler: string | null }>(
    `select v.record->'definition'->'approval'->>'handler' as handler from runs r
      join workflow_versions v on v.id=r.workflow_version_id where r.id=$1`, [input.binding.runId])).rows[0]?.handler
}

async function createLocalFileServer(input: ProductionClaudeInput, allowMutation: boolean, signal: AbortSignal,
  manager: () => ClaudeNativeSessionManager | undefined) {
  const files = input.files!
  if (input.binding.kind === 'workflow') throw new DomainError('CLAUDE_FILE_SCOPE_UNAVAILABLE', 'Workflow file authority must use its admitted execution file domain.', 409)
  if (input.mode === 'replay' && !files.sdk) throw new DomainError('HARNESS_REPLAY_INCOMPLETE', 'Claude file replay requires its SDK server/tool port.', 500)
  const sdk = await (files.sdk ? files.sdk() : import('@anthropic-ai/claude-agent-sdk'))
  signal.throwIfAborted()
  return createClaudeFileMcpServer({ sdk, service: files.service(), allowMutation,
    calls: createClaudeFileCallResolver({ manager, signal }),
    admission: productionClaudeFileAdmission({ pool: input.pool, binding: input.binding, manager, allowMutation }) })
}

function assertSelectedAccountMatches(configuration: ProductionClaudeInput['configuration'],
  account: Awaited<ReturnType<typeof resolveRuntimeProviderAccount>>): void {
  if (configuration.accountId && !account) throw new DomainError('PROVIDER_ACCOUNT_UNAVAILABLE',
    'The selected managed provider account is unavailable.', 409)
  if (account && (account.accountId !== configuration.accountId
    || account.homePath !== configuration.configDirectory || account.authMode !== configuration.authMode)) {
    throw new DomainError('PROVIDER_ACCOUNT_CONFIGURATION_CONFLICT',
      'Save the selected account settings before starting this Claude session.', 409)
  }
}

export function productionClaudeManager(input: ProductionClaudeInput) {
  input = ownedClaudeInput(input)
  let actual: ClaudeNativeSessionManager | undefined
  let inspectedStart: NativeSessionStart | undefined
  let sessionStart: NativeSessionStart | undefined
  const inspectionStart = async () => {
    if (!inspectedStart) {
      const start = structuredClone(await input.inspectionStart())
      if (input.consultation) {
        if (!hasWorkflowRequest(start)) throw new DomainError('CLAUDE_OWNER_UNAVAILABLE',
          'Consultation inspection requires its original workflow request.', 409)
        inspectedStart = { ...start, kind: 'workflow-consultation', consultation: input.consultation,
          correlationId: `consultation:${input.consultation.consultationId}`, instructionsDelivered: true }
      } else inspectedStart = start
    }
    return structuredClone(inspectedStart)
  }
  let policyBridge: ClaudeInteractionBridge | undefined
  let fileServer: ReturnType<typeof createClaudeFileMcpServer> | undefined
  let allocated: ((manager: ClaudeNativeSessionManager) => void) | undefined
  const result = input.factories.allocateAdmittedClaude(async signal => {
    if (!input.configuration.accountId) requireClaudeApiKey(input.configuration, input.apiKey)
    if (!input.profiles || !input.selector) throw new DomainError('HARNESS_PROFILE_UNAVAILABLE',
      'Claude requires an explicit accepted profile and current native qualification authority.', 409)
    if (input.mode === 'replay' && !input.loadClient) throw new DomainError('HARNESS_REPLAY_INCOMPLETE',
      'Claude replay requires the SDK client port and cannot load a native SDK.', 500)
    const profileOwner: ClaudeProfileOwner = { ...input.binding, admissionSignal: signal,
      ...(input.consultation ? { purpose: 'consultation', consultation: input.consultation } : {}) }
    const account = await resolveRuntimeProviderAccount(input.accounts, 'claude', input.configuration.accountId,
      input.recovery, input.accountSourceRecovery, input.accountBinding)
    assertSelectedAccountMatches(input.configuration, account)
    const apiKey = account?.apiKey ?? input.apiKey
    requireClaudeApiKey(input.configuration, apiKey)
    const accepted = await admitWhenChecked(() => input.profiles!.admit(profileOwner, input.selector!), signal)
    assertRuntimeProviderAccountProfile(input.accountBinding, accepted.override.target)
    signal.throwIfAborted()
    const compiled = compileClaudeConfiguration(input.configuration, input.workingDirectory, accepted,
      hostEnvironment(), apiKey)
    const installation = input.registry.pinOverride(accepted.override)
    const binary = installation.installation.launcher.resolvedLauncher
    if (!binary) throw new DomainError('HARNESS_INSTALLATION_UNAVAILABLE', 'The accepted Claude launcher is unavailable.', 409)
    // This application process executes only original-main allocations. Remote
    // placement has its own authenticated host factory and cannot borrow it.
    if (accepted.override.target.hostRef.kind !== 'main') throw new DomainError('HARNESS_HOST_MISMATCH',
      'A registered-device profile must execute through its authenticated host.', 409)
    const domainBinding = input.binding.kind === 'workflow'
      ? { ...input.binding, ...(input.consultation ? { consultation: structuredClone(input.consultation) } : {}) } : input.binding
    // A workflow whose Agents handle approvals themselves runs this Claude Agent's tools without asking.
    const handler = await workflowApprovalHandler(input)
    const domain = createPostgresClaudeInteractionBridge({ database: input.pool, binding: domainBinding, autoAllowTools: handler === 'native',
      configuration: compiled.configuration, manager: { nativeCallbackContext: (sessionId, toolUseId) => actual?.nativeCallbackContext(sessionId, toolUseId) } })
    policyBridge = domain.bridge
    let callbackAuthority = await domain.callbackAdmissionIfActive()
    signal.throwIfAborted()
    const scope = { deviceId: accepted.override.target.hostRef.mainId, profilePath: compiled.configuration.configDirectory,
      configRevision: accepted.currentBinding.pin.configRevision, cwd: input.workingDirectory }
    const runner = createClaudeSdkRunner({ loadClient: async () => {
      await input.profiles!.revalidate({ ...profileOwner, admissionSignal: signal }, accepted)
      await input.factories.assertInstallationUnchanged(installation, signal)
      signal.throwIfAborted()
      return (input.loadClient ?? ((selected) => loadOfficialClaudeSdk(selected.profilePath, selected.recovery, selected.binary)))({
        profilePath: scope.profilePath, recovery: input.recovery, binary,
      })
    } })
    allocated = manager => {
      actual = manager
      domain.bridge.subscribePending(notification => manager.notifyPendingChanged(notification))
      const readHistory = manager.history.bind(manager)
      manager.history = async (session, effectSignal) => ({ ...await readHistory(session, effectSignal),
        responseDeliveries: await domain.bridge.deliveryEvidence(session) })
      const reconcile = manager.reconcile.bind(manager)
      manager.reconcile = async (session, correlationId, effectSignal) => {
        const history = await reconcile(session, correlationId, effectSignal)
        return { ...history, responseDeliveries: await domain.bridge.deliveryEvidence(session) }
      }
      const initial = manager.startInitialTurn.bind(manager)
      manager.startInitialTurn = async function* (start, message, effectSignal) {
        assertNoInheritedAppMcpToken(input, start)
        callbackAuthority = await domain.callbackAdmission()
        effectSignal?.throwIfAborted()
        sessionStart = structuredClone(start)
        yield* initial(start, { ...message, callbackAuthority }, effectSignal)
      }
      const attach = manager.attachSession.bind(manager)
      manager.attachSession = async (session, start, effectSignal) => {
        assertNoInheritedAppMcpToken(input, start)
        await domain.callbackAdmissionIfActive()
        effectSignal?.throwIfAborted()
        const attached = await attach(session, start, effectSignal)
        sessionStart = structuredClone(start)
        return attached
      }
      if (manager.forkSession) {
        // A Run follow-up chat forks the Run session; its later turns re-attach with the fork's start.
        const fork = manager.forkSession.bind(manager)
        manager.forkSession = async (source, start, effectSignal) => {
          assertNoInheritedAppMcpToken(input, start)
          await domain.callbackAdmissionIfActive()
          effectSignal?.throwIfAborted()
          const forked = await fork(source, start, effectSignal)
          sessionStart = structuredClone(start)
          return forked
        }
      }
      const turn = manager.startTurn.bind(manager)
      if (input.binding.kind === 'workflow') bindConsultationAccess(manager, domain,
        () => sessionStart, start => { sessionStart = structuredClone(start) })
      manager.startTurn = async function* (session, message, effectSignal) {
        let attached: NativeSessionReference
        try {
          callbackAuthority = await domain.callbackAdmission()
          effectSignal?.throwIfAborted()
          if (!sessionStart) throw new DomainError('CLAUDE_SESSION_CONTEXT_REQUIRED',
            'The message requires its admitted native session context.', 409)
          attached = await attach(session, sessionStart, effectSignal)
        } catch (error) {
          throw new ClaudeInputNotDeliveredError(error instanceof Error ? error.message : 'Claude could not prepare the next input.', { cause: error })
        }
        const acceptedMessage = { ...message, callbackAuthority }
        yield* turn(attached, acceptedMessage, effectSignal)
      }
    }
    if (input.files) fileServer = await createLocalFileServer(input, compiled.configuration.sandbox !== 'read-only', signal, () => actual)
    domain.bridge.bindMcpTools(fileServer ? [fileServer.manifest] : [])
    const callbacks = createClaudeSdkCallbacks({ manager: () => actual!, bridge: domain.bridge })
    const serverName = appMcpServerName(compiled.mcpServers)
    const appServer = compiled.mcpServers[serverName]
    const options = { cwd: compiled.cwd, model: compiled.model, permissionMode: compiled.permissionMode,
      ...(compiled.effort ? { effort: compiled.effort } : {}),
      tools: compiled.tools, allowedTools: compiled.allowedTools, disallowedTools: compiled.disallowedTools,
      strictMcpConfig: compiled.strictMcpConfig, settingSources: compiled.settingSources, systemPrompt: compiled.systemPrompt,
      mcpServers: { ...(input.appMcpAccess === 'none' ? Object.fromEntries(Object.entries(compiled.mcpServers).filter(([name]) => !isSupportedAppMcpServerName(name))) : compiled.mcpServers),
        ...(fileServer ? { 'graphql-files': fileServer.server } : {}) }, env: compiled.env, sandbox: compiled.sandbox, includePartialMessages: true, forwardSubagentText: true, ...callbacks }
    return { harness: 'claude', role: input.role, workingDirectory: input.workingDirectory, ownerAgentId: input.ownerAgentId,
      appMcpAccess: input.appMcpAccess, processRecovery: input.recovery, scope, runner, sdkOptions: options,
      qualification: { sdkVersion: accepted.currentBinding.pin.sdkVersion, cliVersion: accepted.currentBinding.pin.cliVersion,
        basicTurns: compiled.qualification.basicTurns, resume: compiled.qualification.resume, fork: compiled.qualification.fork,
        history: compiled.qualification.history, interactions: compiled.qualification.policy.alwaysAppliedToolHook },
      inspectionStart, expectedMcp: { serverName,
        ...(appServer?.type === 'http' ? { url: appServer.url } : {}) },
      interactionPort: domain.interactionPort, liveCallbacks: domain.bridge,
      cancelPendingRequests: () => domain.bridge.cancelPendingRequests(),
      pendingInteractions: session => domain.bridge.pendingInteractions(session),
      responseDeliveries: session => domain.bridge.deliveryEvidence(session),
      messageSubmitted: correlationId => domain.authority.messageSubmitted(correlationId),
      ownerForStart: () => ({ ownerId: input.binding.kind === 'workflow' ? input.binding.runId : input.binding.conversationId,
        attemptId: callbackAuthority?.attemptId ?? 'session-control',
        generation: input.recovery.launchId ?? callbackAuthority?.attemptId ?? 'session-control' }),
      // Filled by the common factory's construction callback below, before any SDK query.
      inspector: claudeProductionMcpInspector({ manager: () => actual!, start: inspectionStart,
        workingDirectory: input.workingDirectory, cliVersion: accepted.currentBinding.pin.cliVersion }),
    }
  }, result => allocated?.(result.manager))
  result.manager.setSessionControlPrincipal = principalId => setControlPrincipal(input.binding, principalId)
  // Factory initialization remains lazy; the admitted allocator's exact instance
  // is captured in the construction callback rather than selected by harness ID.
  const refresh = result.manager.refreshInspectionCredentials.bind(result.manager)
  const refreshSession = result.manager.refreshSessionCredentials.bind(result.manager)
  let refreshingMcp = false
  const refreshOwnedCredentials = async (start: NativeSessionStart, servers: Readonly<Record<string, unknown>>,
    signal?: AbortSignal, session?: NativeSessionReference) => {
    if (refreshingMcp) throw new DomainError('CLAUDE_MCP_CONTROL_CONFLICT', 'An MCP credential refresh is already in progress.', 409)
    refreshingMcp = true
    try {
      policyBridge?.bindMcpTools(fileServer ? [fileServer.manifest] : [])
      if (input.appMcpAccess === 'none' && Object.keys(servers).some(isSupportedAppMcpServerName)) {
        throw new DomainError('HARNESS_ROLE_AUTHORITY_INVALID', 'This Claude owner cannot receive management MCP tools.', 403)
      }
      if (fileServer && servers['graphql-files'] !== undefined && servers['graphql-files'] !== fileServer.server) {
        throw new DomainError('CLAUDE_MCP_SCOPE_CONFLICT', 'The local file server cannot be replaced during credential refresh.', 409)
      }
      const acceptedServers = { ...servers, ...(fileServer ? { 'graphql-files': fileServer.server } : {}) }
      const snapshot = session ? await refreshSession(session, start, acceptedServers, signal)
        : await refresh(start, acceptedServers, signal)
      const manifests = input.appMcpAccess === 'none' ? [] : await acceptedClaudeAppTools({
        configuration: input.configuration, servers: acceptedServers,
        token: readProductEnvironment(start.environment?.variables ?? {}, 'MCP_TOKEN'),
        ...(signal ? { signal } : {}),
      })
      policyBridge!.bindMcpTools([...manifests, ...(fileServer ? [fileServer.manifest] : [])])
      inspectedStart = structuredClone(start)
      if (session) sessionStart = structuredClone(start)
      return snapshot
    } finally {
      refreshingMcp = false
    }
  }
  result.manager.refreshInspectionCredentials = (start, servers, signal) => refreshOwnedCredentials(start, servers, signal)
  result.manager.refreshSessionCredentials = (session, start, servers, signal) => refreshOwnedCredentials(start, servers, signal, session)
  if ((input.role === 'operator' || input.role === 'agent-chat') && input.appMcpAccess === 'scoped') bindConversationCredentialRefresh(result.manager)
  if (input.role === 'agent-chat' && input.appMcpAccess === 'scoped') bindAgentChatCredentialDelivery(result.manager)
  const dispose = result.manager.dispose!.bind(result.manager)
  result.manager.dispose = async () => {
    try { await dispose() } finally {
      policyBridge?.close()
      await fileServer?.close()
      inspectedStart = undefined
    }
  }
  return { ...result, inspectionStart }
}

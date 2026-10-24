import { isDeepStrictEqual } from 'node:util'
import type pg from 'pg'
import {
  RETIRED_OPENCODE_MESSAGE,
  type AgentConfigurationVersion, type CompactionState, type NativeSessionReference, type OperatorConfigurationVersion,
} from '@foreman-code/contracts'
import type { WorkerConversationBinding } from '@foreman-code/contracts/remote-execution-rpc'
import { ApprovedRootAllowlistSchema, WORKSPACE_ROOT_EXTENSION } from '@foreman-code/contracts/workspace-root-policies'
import type { prepareOperatorChatInput } from '../collaboration/index.js'
import type { ProductionDeviceRuntime } from '../devices/index.js'
import { DomainError } from '../errors.js'
import type { ClaudeProfileOwner } from '../harnesses/claudeSdk/production.js'
import { recoverPersistedClaudeCompaction } from '../harnesses/claudeSdk/recoverCompaction.js'
import type { AcceptedHarnessProfileAdmission } from '../harnesses/instanceSettings/acceptedProfile.js'
import type { HostHarnessInstanceProfileChecks } from '../harnesses/index.js'
import type { HarnessInstanceSettingsRepository } from '../harnesses/index.js'
import type { NativeSessionStart } from '../harnesses/port.js'
import type { ProductionHarnessRegistry } from '../harnesses/productionRegistry.js'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import type { NativeHarnessFactories } from '../harnesses/index.js'
import { sessionStartDirectory } from '../harnesses/sessionStart.js'
import { workflowProfileSelection } from '../harnesses/index.js'
import { readAcceptedPlacement, readExecutionPlacement, readNativePlacement } from '../placement/index.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import type { AgentChatManagerFactory } from './agentChat.js'
import type { PostgresAgentChatRepository } from './agentChatRepository.js'
import type { PostgresOperatorConversationRepository } from './operatorChatRepository.js'
import type { createProductionWorkerConversations } from './workerProduction.js'

/** The Worker the Operator's selected profile runs on must be the connected one; its managed runtime root is the chat's directory. */
export function createWorkerChatPreflight(devices: Pick<ProductionDeviceRuntime, 'endpointForDomains'>): Parameters<typeof prepareOperatorChatInput>[1] {
  return async profile => {
    const host = profile.target.hostRef
    if (host.kind !== 'device') throw new DomainError('CHAT_PREFLIGHT_UNAVAILABLE', 'The Worker profile is unavailable.', 409)
    const endpoint = devices.endpointForDomains()
    const channel = endpoint.captureRequest(host.deviceId, WORKSPACE_ROOT_EXTENSION.namespace)
    if (!channel || channel.binding.mainId !== host.mainId
      || channel.binding.workerInstallationId !== profile.target.applicationInstallationId) {
      throw new DomainError('CHAT_PREFLIGHT_UNAVAILABLE', 'The selected Worker is unavailable.', 503)
    }
    const response = await channel.request({ version: 1, operation: 'workspace-roots.configuration' },
      { signal: new AbortController().signal })
    const roots = ApprovedRootAllowlistSchema.parse(response.payload)
    if (response.bytes !== undefined || !isDeepStrictEqual(roots.hostRef, host)
      || roots.applicationInstallationId !== profile.target.applicationInstallationId
      || !isDeepStrictEqual(endpoint.captureRequest(host.deviceId, WORKSPACE_ROOT_EXTENSION.namespace)?.binding, channel.binding)) {
      throw new DomainError('CHAT_PREFLIGHT_UNAVAILABLE', 'The selected Worker root changed during input preparation.', 409)
    }
    return roots.managedRuntimeRoot
  }
}

/** The profile selection and source execution an Agent chat runs with; a chat opened from a Run follows that Run's placement. */
export function createAgentChatProfileSelection(dependencies: {
  pool: pg.Pool
  runs: Pick<PostgresRunRepository, 'getExecution'>
}) {
  const { pool, runs } = dependencies
  return async (configuration: AgentConfigurationVersion, workingDirectory: string, executionId?: string) => {
    if (!executionId) return { profileSelection: configuration.harnessProfileSelection, sourceExecution: undefined }
    const source = await runs.getExecution(executionId)
    if (!source || source.agentId !== configuration.agentId
      || source.agentConfigurationVersionId !== configuration.id || source.workingDirectory !== workingDirectory) {
      throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The chat source execution changed.', 409)
    }
    const placement = await readExecutionPlacement(pool, executionId)
    if (!placement) {
      if (await readAcceptedPlacement(pool, source.runId, source.workflowNodeId)) {
        throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The chat source placement is unavailable.', 409)
      }
      return { profileSelection: configuration.harnessProfileSelection, sourceExecution: undefined }
    }
    const native = await readNativePlacement(pool, executionId)
    if (!native) {
      throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The chat source working tree is unavailable.', 409)
    }
    const harness = configuration.harness.harness
    if (harness === 'opencode') throw new DomainError('HARNESS_RETIRED', 'OpenCode is retired; this chat source cannot continue.', 409)
    const profileSelection = workflowProfileSelection({ executionId, runId: source.runId, agentId: source.agentId,
      harness, configuration, workingDirectory, acceptedPlacement: placement },
    native?.workingTree.canonicalCwd)
    return { profileSelection, sourceExecution: { executionId, placement, workingTree: native.workingTree } }
  }
}
export type AgentChatProfileSelection = ReturnType<typeof createAgentChatProfileSelection>

/** Reads a chat's saved compaction back from the native history, on the Worker or on this computer. */
export function createChatCompactionRecovery(dependencies: {
  workerChats: Pick<ReturnType<typeof createProductionWorkerConversations>, 'create'>
  selectedProfiles: AcceptedHarnessProfileAdmission<ClaudeProfileOwner>
  harnessRegistry: ProductionHarnessRegistry
  processRegistry: Pick<NativeProcessRegistry, 'scope'>
  nativeFactories: NativeHarnessFactories
  operatorConversations: PostgresOperatorConversationRepository
  agentConversations: PostgresAgentChatRepository
}) {
  const { workerChats, selectedProfiles, harnessRegistry, processRegistry, nativeFactories, operatorConversations, agentConversations } = dependencies
  return async (
    configuration: OperatorConfigurationVersion | AgentConfigurationVersion,
    conversationId: string, session: NativeSessionReference,
    start: NativeSessionStart, state: CompactionState,
    principalId: string, signal: AbortSignal,
    profileSelection = configuration.harnessProfileSelection,
    sourceExecution?: WorkerConversationBinding['sourceExecution'],
  ): Promise<CompactionState> => {
    if (session.harness === 'opencode' || configuration.harness.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    }
    if (profileSelection?.target.hostRef.kind === 'device') {
      const manager = workerChats.create({ configuration, conversationId, workingDirectory: sessionStartDirectory(start),
        appMcpAccess: 'none', lifecycle: 'observer', observationPrincipalId: principalId, profileSelection, sourceExecution })
      try { return await manager.readCompaction!(session, start, state, signal) }
      finally { await manager.dispose?.() }
    }
    if (session.harness === 'claude') return recoverPersistedClaudeCompaction(state)
    const binding: ClaudeProfileOwner = 'operatorId' in configuration
      ? { kind: 'operator', conversationId, repository: operatorConversations, observationPrincipalId: principalId }
      : { kind: 'agent', conversationId, workspaceId: configuration.workspaceId,
        repository: agentConversations, observationPrincipalId: principalId }
    const accepted = profileSelection
      ? await selectedProfiles.admit({ ...binding, admissionSignal: signal }, profileSelection) : undefined
    const selection = accepted ? harnessRegistry.pinOverride(accepted.override)
      : harnessRegistry.pinAccepted({ id: configuration.id,
        agentId: 'operatorId' in configuration ? configuration.operatorId : configuration.agentId,
        harness: configuration.harness })
    const common = { selection, configured: selection.instance, role: 'diagnostics' as const,
      accountRecovery: processRegistry.scope('operatorId' in configuration
        ? `conversation:${conversationId}` : `conversation:agent-chat:${conversationId}`),
      workingDirectory: sessionStartDirectory(start),
      ownerAgentId: 'operatorId' in configuration ? configuration.operatorId : configuration.agentId,
      appMcpAccess: 'none' as const,
      ...(accepted ? { revalidateSelection: (effectSignal?: AbortSignal) => selectedProfiles.revalidate(
        { ...binding, admissionSignal: effectSignal ?? signal }, accepted) } : {}) }
    const { manager } = nativeFactories.allocate({ ...common, harness: session.harness })
    try {
      await nativeFactories.admitAuxiliary(manager)
      return await manager.readCompaction!(session, start, state, signal)
    } finally { await nativeFactories.disposeAuxiliary(manager) }
  }
}
export type ChatCompactionRecovery = ReturnType<typeof createChatCompactionRecovery>

/** An Agent chat's compaction follows the Run it was opened from, when it has one. */
export function createAgentChatCompactionRecovery(dependencies: {
  agentConversations: PostgresAgentChatRepository
  profileSelection: AgentChatProfileSelection
  recover: ChatCompactionRecovery
}): NonNullable<AgentChatManagerFactory['recoverCompaction']> {
  const { agentConversations, profileSelection, recover } = dependencies
  return async (configuration, conversationId, session, start, state, principalId, signal) => {
    const row = await agentConversations.get(conversationId)
    if (!row || row.agent_configuration_version_id !== configuration.id) {
      throw new DomainError('PLACEMENT_BINDING_CONFLICT', 'The chat configuration changed.', 409)
    }
    const executionId = row.record.origin.kind === 'run_execution' && !row.record.sourceConfigurationVersionId
      ? row.record.origin.executionId : undefined
    const selected = await profileSelection(configuration, sessionStartDirectory(start), executionId)
    return recover(configuration, conversationId, session, start, state, principalId, signal,
      selected.profileSelection, selected.sourceExecution)
  }
}

/** Why an Agent chat opened from a Run cannot run: its harness profile is still being checked or no longer qualifies. */
export function createAgentChatAvailability(dependencies: {
  profileSelection: AgentChatProfileSelection
  hostSettings: HarnessInstanceSettingsRepository
  hostProfileChecks: Pick<HostHarnessInstanceProfileChecks, 'pending'>
  harnessRegistry: Pick<ProductionHarnessRegistry, 'profileEvidence'>
}): NonNullable<AgentChatManagerFactory['unavailable']> {
  const { profileSelection: selectProfile, hostSettings, hostProfileChecks, harnessRegistry } = dependencies
  return async (configuration, workingDirectory, executionId) => {
    const { profileSelection } = await selectProfile(configuration, workingDirectory, executionId)
    if (!profileSelection) return undefined
    const profile = await hostSettings.readAuthorized(client => hostSettings.latest(client, profileSelection.instanceId))
    if (profile && hostProfileChecks.pending(profile)) {
      return { reason: 'harness_unavailable', message: 'This harness profile is being checked. Retry shortly.' }
    }
    if (!profile || !profile.enabled || profile.instanceRevision !== profileSelection.instanceRevision
      || !await harnessRegistry.profileEvidence(profile)) {
      return { reason: 'harness_unavailable', message: 'The harness profile used by this Run is unavailable.' }
    }
    return undefined
  }
}

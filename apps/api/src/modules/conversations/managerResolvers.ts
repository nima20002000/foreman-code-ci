import { INSTALLATION_NAMES } from '@foreman-code/contracts/installation-names'
import type { FastifyInstance } from 'fastify'
import type pg from 'pg'
import { type AgentConfigurationVersion } from '@foreman-code/contracts'
import type { AcceptedProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import type { ApiConfig } from '../../config.js'
import { conversationChatTools } from '../access/index.js'
import type { ConversationNativeAccess } from '../collaboration/index.js'
import { DomainError } from '../errors.js'
import { productionFileTools } from '../files/index.js'
import {
  assertActiveHarnessConfiguration, capabilityDescriptorsOf,
  operatorCodexFileAdmissions, productionClaudeManager, productionCodexChatFiles,
  productionOperatorManagers, productionSelectedProfileManager,
  type NativeHarnessFactories, type NativeHarnessSessionManager, type NativeLaunchRecords,
  type NativeProcessRegistry, type NativeResponseJournal, type ProductionCodexChatFiles,
  type ProductionHarnessInfrastructure, type ProductionHarnessRegistry,
  type AcceptedClaudeProfileAdmission, type AcceptedHarnessProfileAdmission, type ClaudeProfileOwner,
} from '../harnesses/index.js'
import type { ProviderAccountsService } from '../provider-accounts/index.js'
import type { ConversationFeatureContext } from './conversationFeatureSubject.js'
import type { AgentChatProfileSelection } from './chatSources.js'
import type { PostgresAgentChatRepository } from './agentChatRepository.js'
import type { NativeManagerResolver } from './operatorChat.js'
import { nativeCorrelation, type PostgresOperatorConversationRepository } from './operatorChatRepository.js'
import type { createProductionWorkerConversations } from './workerProduction.js'

type ConversationManagerDependencies = {
  app: () => FastifyInstance
  pool: pg.Pool
  harnessMode: 'native' | 'replay'
  infrastructure: ProductionHarnessInfrastructure | undefined
  processRegistry: Pick<NativeProcessRegistry, 'scope' | 'closeOwner'>
  nativeFactories: NativeHarnessFactories
  harnessRegistry: ProductionHarnessRegistry
  providerAccounts: ProviderAccountsService
  claudeProfiles: AcceptedClaudeProfileAdmission<ClaudeProfileOwner>
  selectedProfiles: AcceptedHarnessProfileAdmission<ClaudeProfileOwner>
  workerChats: Pick<ReturnType<typeof createProductionWorkerConversations>, 'create'>
}

/** Allocates Operator managers with their accepted profile, account and file authority. */
export function createOperatorManagerResolver(dependencies: ConversationManagerDependencies & {
  config: ApiConfig
  workingDirectory: string
  fileStorageRoot: string
  responseJournal: NativeResponseJournal
  managers: Map<string, NativeHarnessSessionManager>
  operatorConversations: PostgresOperatorConversationRepository
  operatorAccountBindings: Map<string, AcceptedProviderAccountBinding>
  launches: NativeLaunchRecords
  chat: NonNullable<Parameters<typeof productionOperatorManagers>[0]['chat']>
}): NativeManagerResolver {
  const { app, pool, config, workingDirectory: operatorWorkingDirectory, fileStorageRoot, harnessMode, infrastructure,
    processRegistry, responseJournal, managers: operatorManagers, nativeFactories, harnessRegistry, providerAccounts,
    claudeProfiles, selectedProfiles, workerChats, operatorConversations, operatorAccountBindings, launches, chat } = dependencies
  return productionOperatorManagers({
    app, pool, config, workingDirectory: operatorWorkingDirectory,
    processRegistry, responseJournal, managers: operatorManagers, nativeFactories,
    accountBinding: conversationId => operatorAccountBindings.get(conversationId),
    createDevice: (configuration, conversationId, fileInputs) => workerChats.create({
      configuration, conversationId, workingDirectory: operatorWorkingDirectory, fileInputs,
      appMcpAccess: fileInputs && capabilityDescriptorsOf(configuration.harness).files === 'session_bridge' ? 'none' : 'scoped' }),
    createSelected: (configuration, conversationId, fileInputs, recovery) => {
      assertActiveHarnessConfiguration(configuration.harness)
      if (!configuration.harnessProfileSelection || configuration.harness.harness === 'claude') throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'The selected Operator driver profile is unavailable.', 409)
      return productionSelectedProfileManager({ factories: nativeFactories, registry: harnessRegistry, profiles: selectedProfiles,
        ...(operatorAccountBindings.get(conversationId)
          ? { accountBinding: operatorAccountBindings.get(conversationId)! } : {}),
        selector: configuration.harnessProfileSelection, binding: { kind: 'operator', conversationId, repository: operatorConversations },
        configuration: configuration.harness, role: 'operator', workingDirectory: operatorWorkingDirectory, ownerAgentId: configuration.operatorId,
        recovery, appMcpAccess: 'scoped',
        ...(fileInputs ? { files: productionCodexChatFiles(app, conversationId, operatorCodexFileAdmissions(app, pool,
          configuration, operatorWorkingDirectory, fileStorageRoot)) } : {}),
      }).manager
    },
    createClaude: (configuration, conversationId, fileInputs, recovery) => {
      if (configuration.harness.harness !== 'claude') throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'Claude requires the pinned Claude configuration.', 409)
      const controlBinding: Extract<Parameters<typeof productionClaudeManager>[0]['binding'], { kind: 'operator' }>
        = { kind: 'operator', conversationId, repository: operatorConversations }
      const claude = productionClaudeManager({ pool, factories: nativeFactories, registry: harnessRegistry,
        accounts: providerAccounts,
        ...(operatorAccountBindings.get(conversationId)
          ? { accountBinding: operatorAccountBindings.get(conversationId)! } : {}),
        profiles: claudeProfiles,
        ...(configuration.harnessProfileSelection ? { selector: configuration.harnessProfileSelection } : {}),
        binding: controlBinding, role: 'operator',
        configuration: configuration.harness, workingDirectory: operatorWorkingDirectory, ownerAgentId: configuration.operatorId,
        recovery, appMcpAccess: fileInputs ? 'none' : 'scoped', mode: harnessMode,
        ...(fileInputs ? { files: { service: () => productionFileTools(app()), ...(infrastructure?.claudeFileSdk ? { sdk: infrastructure.claudeFileSdk } : {}) } } : {}),
        ...(infrastructure?.claudeClient ? { loadClient: infrastructure.claudeClient } : {}),
        inspectionStart: async () => {
          const row = await operatorConversations.active(conversationId)
          if (!row || !row.active_request_id && !controlBinding.controlPrincipalId
            || row.operator_configuration_version_id !== configuration.id) throw new DomainError('CLAUDE_OWNER_UNAVAILABLE', 'The accepted Operator turn is unavailable.', 409)
          return { kind: 'operator', correlationId: nativeCorrelation(conversationId, row.active_request_id ?? 'session-control'), configuration,
            workingDirectory: operatorWorkingDirectory, environment: { agentId: configuration.operatorId, variables: {} } }
        },
      })
      launches.recordClaude(claude)
      return claude.manager
    },
    selectInstallation: (configuration) => harnessRegistry.initialized
      ? harnessRegistry.pinAccepted({ ...configuration, agentId: configuration.operatorId }) : undefined,
    chat,
  })
}

/** Allocates one retained Agent chat manager, independently of its source execution. */
export function createAgentChatManagerResolver(dependencies: ConversationManagerDependencies & {
  managers: Map<string, NativeHarnessSessionManager>
  agentConversations: PostgresAgentChatRepository
  agentChatProfileSelection: AgentChatProfileSelection
  conversationNativeAccess: Pick<ConversationNativeAccess, 'bind'>
  chatFileAdmissions: ProductionCodexChatFiles
}) {
  const { app, pool, harnessMode, infrastructure, processRegistry, nativeFactories, harnessRegistry, providerAccounts,
    claudeProfiles, selectedProfiles, workerChats, managers: agentChatManagers, agentConversations,
    agentChatProfileSelection, conversationNativeAccess, chatFileAdmissions } = dependencies
  return async (conversationId: string, configuration: AgentConfigurationVersion, workingDirectory: string,
    accountSource?: { executionId: string }, featureContext?: ConversationFeatureContext): Promise<NativeHarnessSessionManager> => {
    assertActiveHarnessConfiguration(configuration.harness)
    const existing = agentChatManagers.get(conversationId)
    if (existing) return existing
    const accountBinding = await providerAccounts.runtimeBinding('agent-conversation', conversationId,
      configuration.harness, configuration.harnessProfileSelection)
    const selected = await agentChatProfileSelection(configuration, workingDirectory, accountSource?.executionId)
    const selector = selected.profileSelection
    const resolved = agentChatManagers.get(conversationId)
    if (resolved) return resolved
    const appMcpAccess = featureContext && conversationChatTools(featureContext).length ? 'scoped' as const : 'none' as const
    if (selector?.target.hostRef.kind === 'device') {
      const manager = workerChats.create({ configuration, conversationId, workingDirectory, appMcpAccess, fileInputs: true,
        profileSelection: selector, sourceExecution: selected.sourceExecution,
        applicationAccess: start => {
          const token = start.environment?.variables[INSTALLATION_NAMES.environment.MCP_TOKEN]
          return token ? { kind: 'agent-chat-mcp', token } : undefined
        } })
      if (featureContext) await conversationNativeAccess.bind(manager, featureContext)
      agentChatManagers.set(conversationId, manager)
      return manager
    }
    // Chat processes have their own owner scope; they never share a workflow execution's manager.
    const recovery = processRegistry.scope(`conversation:agent-chat:${conversationId}`)
    const sourceRecovery = accountSource
      ? { accountSourceRecovery: processRegistry.scope(`execution:${accountSource.executionId}`) } : {}
    const harness = configuration.harness
    if (harness.harness === 'claude') {
      const { manager } = productionClaudeManager({ pool, factories: nativeFactories, registry: harnessRegistry,
        ...sourceRecovery,
        ...(accountBinding?.kind === 'slot' ? { accountBinding } : {}),
        accounts: providerAccounts,
        profiles: claudeProfiles,
        ...(selector ? { selector } : {}),
        binding: { kind: 'agent', conversationId, workspaceId: configuration.workspaceId, repository: agentConversations },
        role: 'agent-chat', configuration: harness, workingDirectory, ownerAgentId: configuration.agentId, recovery,
        appMcpAccess, mode: harnessMode,
        files: { service: () => productionFileTools(app()), ...(infrastructure?.claudeFileSdk ? { sdk: infrastructure.claudeFileSdk } : {}) },
        ...(infrastructure?.claudeClient ? { loadClient: infrastructure.claudeClient } : {}),
        inspectionStart: async () => { throw new DomainError('CLAUDE_MANAGEMENT_MCP_FORBIDDEN', 'Agent chat has no management MCP inspection authority.', 403) },
      })
      if (featureContext) await conversationNativeAccess.bind(manager, featureContext)
      agentChatManagers.set(conversationId, manager)
      return manager
    }
    if (selector) {
      const { manager } = productionSelectedProfileManager({ factories: nativeFactories, registry: harnessRegistry, profiles: selectedProfiles,
        ...sourceRecovery,
        ...(accountBinding?.kind === 'slot' ? { accountBinding } : {}),
        selector,
        binding: { kind: 'agent', conversationId, workspaceId: configuration.workspaceId, repository: agentConversations },
        configuration: harness, role: 'agent-chat', workingDirectory, ownerAgentId: configuration.agentId, recovery, appMcpAccess,
        files: productionCodexChatFiles(app, conversationId, chatFileAdmissions) })
      if (featureContext) await conversationNativeAccess.bind(manager, featureContext)
      agentChatManagers.set(conversationId, manager)
      return manager
    }
    const selection = harnessRegistry.initialized ? harnessRegistry.pinAccepted(configuration) : undefined
    const { manager } = nativeFactories.allocate({
      ...sourceRecovery,
      ...(accountBinding?.kind === 'slot' ? { accountBinding } : {}),
      ...(selection ? { selection } : {}),
      role: 'agent-chat', workingDirectory, ownerAgentId: configuration.agentId,
      configured: { instanceId: selection?.instance.instanceId ?? configuration.agentId, instanceRevision: configuration.id, driverId: harness.harness,
        enabled: true, configuration: harness },
      processRecovery: recovery, appMcpAccess,
      harness: 'codex',
      chatFiles: productionCodexChatFiles(app, conversationId, chatFileAdmissions),
    })
    if (featureContext) await conversationNativeAccess.bind(manager, featureContext)
    agentChatManagers.set(conversationId, manager)
    return manager
  }
}

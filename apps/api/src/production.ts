import { createAgentChatManagerResolver, createOperatorManagerResolver } from './composition/managerResolvers.js'
import { BROWSER_DEVICE_EXTENSION } from '@foreman-code/contracts'
import { createProductionBrowser } from './modules/collaboration/browserComposition.js'
import { createMainBrowserRemote } from './modules/collaboration/browserRemote.js'
import { prepareAgentChatInput, prepareOperatorChatInput } from './modules/collaboration/chatInputPreparation.js'
import { ConversationCredentials } from './modules/access/conversationCredentialIssuer.js'
import { readConversationCredential } from './modules/access/conversationCredentials.js'
import { ConversationNativeAccess } from './modules/collaboration/conversationNativeAccess.js'
import { createProductionChatDelivery } from './modules/collaboration/chatDeliveryProduction.js'
import { createMemoryBoardService } from './modules/memory-boards/production.js'
import { memoryBoardAuthority } from './modules/collaboration/memoryBoardAuthority.js'
import { WorkflowCollaborationIntegration, type WorkflowFeaturePorts } from './modules/collaboration/workflowIntegration.js'
import { createWorkflowExecutionChatService } from './modules/collaboration/workflowChatProduction.js'
import { MANAGED_MCP_NAMESPACE } from '@foreman-code/contracts/managed-mcp-channel'
import { isDatabasePoolTimeout } from '@foreman-code/contracts/failure'
import { DeviceManagedMcp } from './modules/harnesses/deviceManagedMcp.js'
import { RunWorktrees } from './modules/runs/runWorktrees.js'
import { withTransaction } from './infrastructure/transaction.js'
import { ComputerActivityService } from './modules/computers/activity.js'
import { ComputerAccountsService } from './modules/computers/accounts.js'
import {
  AGENT_SNAPSHOT_JSON_BYTES, AGENT_SNAPSHOT_NAMESPACE,
} from '@foreman-code/contracts/source-materialization'
import { startStateDeadlineSweeper } from './modules/diagnostics/stateDeadlines.js'
import { reportServiceFailure, trackService } from './modules/diagnostics/serviceHealth.js'
import { ProductionCiEnrollmentInventory } from './modules/ci/enrollmentInventory.js'
import { CI_HOST_NAMESPACE, CI_RUNTIME_NAMESPACE, DEFAULT_STUCK_EXECUTION_IDLE_MS } from '@foreman-code/contracts'
import { createCiHttpTransport } from './modules/ci/client.js'
import { agentFileReader, CiEnrollment, CiRuntimeProvisioner, createCircleCi, createHostCi } from './modules/ci/mount.js'
import type { CircleCreditUsage, CircleStandby, CloudCis, CiServiceClient, ReadAgentFiles } from './modules/ci/types.js'
import { FleetMaintenanceService } from './modules/computers/fleet.js'
import { computerConnectionsReader } from './modules/computers/connections.js'
import { startWorkerPublicationSync } from './modules/computers/workerPublicationSync.js'
import { createProductionWorkerArtifactExtension, readProductionWorkerManifestSha256s,
  readProductionWorkerContentSha256s, readProductionWorkerReleasePublication,
  workerArtifactLocation } from './modules/computers/workerArtifactsProduction.js'
import { ComputerMaintenance, claudeUserMcpServers, installedPlugins, pluginMarketplaces, systemMaintenancePorts } from './modules/computers/maintenance.js'
import { ComputerGitHubService } from './modules/computers/github.js'
import { COMPUTER_MAINTENANCE_NAMESPACE, COMPUTER_MAINTENANCE_VERSION } from '@foreman-code/contracts/computer-maintenance'
import { COMPUTER_ACCOUNTS_NAMESPACE, COMPUTER_SYNC_NAMESPACE, COMPUTER_GITHUB_NAMESPACE } from '@foreman-code/contracts/computer-accounts'
import { ComputerSyncService } from './modules/computers/sync.js'
import { WORKSPACE_ROOT_EXTENSION } from '@foreman-code/contracts/workspace-root-policies'
import type { ClaudeHarnessConfiguration } from '@foreman-code/contracts/claude'
import { readProductEnvironment } from '@foreman-code/contracts/product-environment'
import { appLauncherPath, appMcpServerName } from './modules/harnesses/appMcpLauncher.js'
import { createMainRsyncEntrypoint } from './modules/byte-transfer/installedEntrypoints.js'
import { PostgresTrustedConnectionSetup } from './modules/devices/trustedConnectionSetup.js'
import type { AcceptedTransferAuthority } from './modules/byte-transfer/carrier.js'
import type { InstalledMainRsyncProviders } from './modules/byte-transfer/productionComposition.js'
import { createInstalledRsyncComposition } from './modules/byte-transfer/productionComposition.js'
import { RSYNC_STAGE_EXTENSION, type TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { JOB_RUNTIME_QUALIFICATION_EXTENSION } from '@foreman-code/contracts/job-runtime'
import { createProductionRemoteWorkflow } from './modules/placement/productionRemoteWorkflow.js'
import { closeCompletedWorkflowSources } from './modules/sources/workflowCleanup.js'
import { remoteWorkflowPreparationClosed } from './modules/sources/workflowPreparationCleanup.js'
import { readExecutionPlacement } from './modules/placement/persistence.js'
import { sourceNativeSessionContinues } from './modules/sources/workingDirectory.js'
import { placedContinuationValidator } from './modules/placement/continuation.js'
import { readSourceCurrentNativeSession } from './modules/sources/activeNativeSession.js'
import type { SourceActiveNativeSessionReader, SourceNativeSessionCaptureReader } from './modules/sources/executionHosts.js'
import { EXECUTION_AUTHORITY_EXTENSION } from '@foreman-code/contracts/execution-authority'
import { WORKER_MCP_EXTENSION, encodeWorkerMcpResult, decodeWorkerMcpRequest } from '@foreman-code/contracts/worker-mcp-relay'
import { AgentPlacementProducer } from './modules/placement/agentProducer.js'
import { RunPlacementReadService } from './modules/placement/readService.js'
import { NodePlacementChoicesService } from './modules/placement/choicesService.js'
import { ProductionPlacementChoiceDiscovery } from './modules/placement/choiceDiscovery.js'
import { readRemoteObservations } from './modules/runs/remote/persistence.js'
import { remoteExecutionStartupEnvironment } from './modules/settings/remoteExecutionConfig.js'
import { RemoteExecutionSettingsService } from './modules/settings/remoteExecution.js'
import { WorkerExecutionPolicy } from './modules/settings/workerExecution.js'
import { AgentExecutionPreparation } from './modules/placement/agentExecutionPreparation.js'
import { createExecutionAuthorityExtension } from './modules/placement/executionAuthority.js'
import { MainWorkerMcpRelay, selectedMainMcpForward, createWorkerNativeOutputAuthorizationPort } from './modules/placement/workerMcpRelay.js'
import { recoverWorkflowArtifactOutputs } from './modules/runs/remote/workflowArtifactRecovery.js'
import { readAcceptedPlacement } from './modules/placement/persistence.js'
import { repeatRuntimeDirectory, type RepeatRepositoryServices } from './modules/runs/repeatRepositoryHost.js'
import { SOURCE_OPERATION_EXTENSION } from '@foreman-code/contracts/source-operations'
import { BYTE_TRANSFER_NAMESPACE } from './modules/byte-transfer/carrier.js'
import { retainInstalledHarnessInventory } from './modules/harnesses/installedCodexInspection.js'
import { existsSync } from 'node:fs'
import { readFile } from 'node:fs/promises'
import { RESOURCE_TELEMETRY_CAPABILITY, type TrustedTelemetryContext } from '@foreman-code/contracts/resource-telemetry'
import { createResourceTelemetryRuntime, type ResourceTelemetryRuntime } from './modules/resource-telemetry/runtime.js'
import { createPassiveTelemetryAuthorities } from './modules/resource-telemetry/productionAuthority.js'
import { createMainResourceTelemetryBindings } from './modules/resource-telemetry/ingestion/carrier.js'
import { WorkspaceBoundLocationService } from './modules/workspace-roots/service.js'
import { ManagedWorkspaceRootService } from './modules/workspace-roots/managedRoot.js'
import { bootstrapLocalMainWorkspaceRoot } from './modules/workspace-roots/localMainBootstrap.js'
import { WorkspaceRepositoryService } from './modules/workspaces/repositoryService.js'
import { RemoteJobMainRpcRequestRecordSchema } from '@foreman-code/contracts/remote-job-execution'
import { JOB_INPUT_NAMESPACE } from './modules/files/jobInputs/service.js'
import { PostgresWorkflowJobNodeStore, workflowJobStorePublication } from './modules/jobs/workflowStore.js'
import { createProductionJobs } from './modules/jobs/production.js'
import type { OperatorServices } from './mcp/operator/types.js'
import { WorkflowHierarchyService } from './modules/workflow-hierarchy/service.js'
import { createClaudeProductionDiscovery } from './modules/harnesses/claudeSdk/bootstrap.js'
import { productionClaudeMetadata } from './modules/harnesses/claudeSdk/productionMetadata.js'
import { initializeNativeDefaults } from './modules/harnesses/initializeDefaults.js'
import { qualifyClaudeNativeProfile } from './modules/harnesses/claudeSdk/nativeProfileQualification.js'
import { discoverInventoryLauncher } from './modules/harnesses/hostDiscovery.js'
import { inventoryDriverPayloads } from './modules/harnesses/payloadDiscovery.js'
import { runCommand } from './modules/harnesses/process.js'
import type { ClaudeProfileOwner } from './modules/harnesses/claudeSdk/production.js'
import { requireClaudeProductionCredentialDelivery } from './modules/harnesses/claudeSdk/productionCredentials.js'
import { ProviderAccountsService } from './modules/provider-accounts/service.js'
import { ProviderAccountsRepository } from './modules/provider-accounts/repository.js'
import { LocalProviderCredentials } from './modules/provider-accounts/localCredentials.js'
import { createProductionAccountSelection } from './modules/provider-accounts/productionSelection.js'
import { createRemoteAccountServices } from './modules/provider-accounts/remoteServices.js'
import { NativeProviderAccountCommands, type AccountNativeSelection } from './modules/provider-accounts/nativeCommands.js'
import { NativeProviderAccountOperations } from './modules/provider-accounts/nativeOperations.js'
import { NativeAccountJournal } from './modules/provider-accounts/nativeJournal.js'
import type { AcceptedProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { ProviderAccountConfigurationService } from './modules/harnesses/providerAccountConfiguration.js'
import { createProductionWorkerConversations } from './modules/conversations/workerProduction.js'
import { REMOTE_EXECUTION_EXTENSION, REMOTE_PREPARATION_EXTENSION, WorkerConversationCallbackSchema } from '@foreman-code/contracts/remote-execution-rpc'
import { executionExtension } from './modules/runs/remote/executionRouter.js'
import { AcceptedHarnessProfileAdmission, AcceptedClaudeProfileAdmission, type AcceptedProfileAuthority } from './modules/harnesses/instanceSettings/acceptedProfile.js'
import type { RecordedAgentDefaults } from '@foreman-code/contracts'
import { inspectClaudeOperatorConfiguration } from './modules/harnesses/claudeSdk/operatorConfigurationInspection.js'
import { inspectWorkerClaudeOperatorConfiguration } from './modules/harnesses/workerClaudeOperatorInspection.js'
import { requireClaudePolicyQualification } from './modules/harnesses/claudeSdk/configuration.js'
import { harnessSignInRequired, onlySignInRequired, qualificationError } from './modules/harnesses/qualificationErrors.js'
import { chatModelOptions } from './modules/harnesses/sessionControlDefaults.js'
import { authorizeOperatorConfigurationRead } from './modules/operators/configurationRead.js'
import { operatorCodexFileAdmissions } from './modules/harnesses/operatorFiles/codex.js'
import { randomUUID } from 'node:crypto'
import { createWorkflowNativeCaptureChannel } from './modules/interactions/workflowNativeCapture.js'
import { createReviewNativeCaptureChannel } from './modules/interactions/reviewNativeCapture.js'
import { ReviewNativeProofServices } from './modules/interactions/reviewNativeProof.js'
import { PostgresRepeatReviewerBindings } from './modules/interactions/repeatReviewer.js'
import { createWorkflowRepositoryServices } from './modules/runs/workflowRepositoryServices.js'
import { createProductionWorkflowArtifactResultSource } from './modules/runs/remote/workflowArtifactResultProduction.js'
import { WorkflowArtifactResultAdoption } from './modules/runs/remote/workflowArtifactResultAdoption.js'
import { createWorkflowArtifactOutputsGate } from './modules/runs/remote/workflowArtifactAcceptance.js'
import { LocalWorkflowArtifactAuthority, workflowArtifactsAreLocal } from './modules/runs/remote/localWorkflowArtifactAuthority.js'
import { LocalWorkflowArtifacts } from './modules/runs/remote/localWorkflowArtifacts.js'
import { readAcceptedRepeatRunLocked } from './modules/runs/repeatStartRead.js'
import { PostgresWorkflowPhysicalArtifacts } from './modules/runs/remote/workflowPhysicalArtifacts.js'
import { readRuntimeIdentity, readRuntimeBuildIdentity } from './infrastructure/runtimeIdentity.js'
import { readTestResourcesIdentity } from './infrastructure/testRuntimeResources.js'
import { fileURLToPath } from 'node:url'
import { AppMcpRoutes } from './modules/harnesses/appMcpRoutes.js'
import { approvalCheckpointConsumers } from './modules/runs/approvalCheckpointRegistration.js'
import { createCurrentNativeProductionFactory, isCurrentNativeProductionBinding } from './modules/runs/workflowProduction.js'
import { isDeepStrictEqual } from 'node:util'
import { NativeResponseJournal } from './modules/harnesses/recovery/responseJournal.js'
import { hasDetachedStdioProcess, hasNativeRestartDetachment, NativeProcessRegistry } from './modules/harnesses/recovery/processRegistry.js'
import { join, resolve } from 'node:path'
import { NativeLaunchRecords } from './modules/harnesses/nativeLaunchRecords.js'
import { createExecutionCredentialProvider } from './modules/interactions/executionCredentials.js'
import { createWorkflowManagerResolver } from './composition/workflowManagerResolver.js'
import { createWorkflowManagerContextPreparer } from './modules/runs/workflowManagerContext.js'
import { createAcceptedDestinationContinuation } from './modules/placement/continuationAuthority.js'
import { workerNativeOutputContext } from './modules/placement/workerNativeOutputContext.js'

import type { ApiConfig } from './config.js'
import { buildApp } from './app.js'
import type { WorkspaceRootPolicyPort } from './modules/sources/rootPolicyPorts.js'
import { createMainTransferAuthority, mainRsyncAuthorizationExtensions, routeMainRsyncAcknowledgements } from './modules/byte-transfer/mainTransferAuthority.js'
import { createMainProviderAccountExtension } from './modules/provider-accounts/mainWorkerAuthority.js'
import { mainProvisioningTarget, readMainProvisioningTarget } from './modules/provider-accounts/mainTarget.js'
import { readMainInstallationId } from './modules/devices/mainIdentity.js'
import { createProductionProfileAuthority } from './modules/harnesses/instanceSettings/productionProfileAuthority.js'
import { deviceHostOverrideAuthority } from './modules/harnesses/instanceSettings/authority.js'
import { createHarnessHost } from './composition/harnessHost.js'
import { late, type Late } from './composition/late.js'
import { createProductionFileStorage, type ProductionFileStorage } from './modules/files/production.js'
import { registerApiRoutes, type ApiRouteServices } from './routes/registry.js'
import { createProductionWorkflowFileContexts } from './modules/runs/remote/workflowNativeFilesProduction.js'
import {
  PostgresArtifactPublicationAuthority,
  PostgresAcceptedArtifactAttemptFence,
  type NativeArtifactAuthorityPorts,
} from './modules/runs/remote/nativeArtifactAuthority.js'
import { createProductionWorkflowArtifacts } from './modules/runs/remote/workflowArtifactProduction.js'
import { createMainWorkflowArtifactTransferExtension } from './modules/runs/remote/workflowArtifactTransferProduction.js'
import type { TemporaryFileService } from './modules/files/service.js'
import { defaultFileStorageRoot } from './modules/files/storage.js'
import { postgresCodexChatFiles } from './modules/harnesses/codexFiles/chatAdmission.js'
import { codexChatHostDirectory, localCodexChatHost } from './modules/harnesses/codexFiles/localHost.js'
import { productionFileTools } from './modules/files/tools/production.js'
import { FileRetentionService } from './modules/files/retention.js'
import { PostgresCommandReceiptRetention } from './modules/commands/receiptRetention.js'
import { createOperatorExtensions } from './composition/operatorExtensions.js'
import { NativeConfigurationService } from './modules/harnesses/nativeConfiguration.js'
import { HarnessMcpSettingsService } from './modules/harnesses/mcpSettings.js'
import { ClaudePluginSettingsService } from './modules/harnesses/claudePlugins.js'
import { readClaudePlugins } from './modules/computers/claudePlugins.js'
import { CodexPluginSettingsService } from './modules/harnesses/codexPluginSettings.js'
import { NativeCodexPlugins } from './modules/harnesses/codexPlugins.js'
import { MainCodexSelection } from './modules/computers/installedCodexSelection.js'
import { workspaceStorageRoot } from './modules/workspaces/storage.js'
import { HarnessDirectoryBrowser } from './modules/harnesses/directoryBrowser.js'
import { CodexMcpConnections } from './modules/harnesses/codexMcpConnections.js'
import type { CheckpointStore } from './composition/checkpoints.js'
import type { createDatabase } from './infrastructure/database.js'
import { OperatorRuntimeOwner } from './infrastructure/operatorRuntimeOwner.js'
import { RuntimeShutdown } from './infrastructure/runtimeShutdown.js'
import { PostgresAccessService } from './modules/access/postgres.js'
import { PostgresLocalHumanAccess } from './modules/access/localHuman.js'
import { CurrentWorkerCredentialService as WorkerCredentialService } from './modules/interactions/current/credentials.js'
import {
  ensureOperatorRuntimeDirectory,
  OperatorChatService,
  PostgresOperatorConversationRepository,
} from './modules/conversations/operatorChat.js'
import { PostgresOperatorChatAuthority } from './modules/conversations/operatorChatAuthority.js'
import { AgentChatService, withAgentChatHooks } from './modules/conversations/agentChat.js'
import { createAgentChatAvailability, createAgentChatCompactionRecovery, createAgentChatProfileSelection,
  createChatCompactionRecovery, createWorkerChatPreflight } from './modules/conversations/chatSources.js'
import { qualifiedAgentChatSteer } from './modules/conversations/chatSteerQualification.js'
import { PostgresAgentChatRepository } from './modules/conversations/agentChatRepository.js'
import { PostgresCommandCoordinator } from './modules/commands/postgres.js'
import { BugReportService } from './modules/bug-reports/service.js'
import { DomainError } from './modules/errors.js'
import { productionSubagentControls } from './modules/subagents/productionControls.js'
import { HarnessCatalogService } from './modules/harnesses/catalog.js'
import { FileCompatibilityCache } from './modules/harnesses/compatibility/cache.js'
import { scopedCompatibilityProbe } from './modules/harnesses/compatibility/scopedProbe.js'
import { HarnessCompatibilityService } from './modules/harnesses/compatibility/service.js'
import { HarnessQualificationRepository } from './modules/harnesses/qualification/repository.js'
import { HarnessQualificationRegistry } from './modules/harnesses/qualification/registry.js'
import { HarnessQualificationService } from './modules/harnesses/qualification/service.js'
import type { QualificationSuite } from './modules/harnesses/qualification/types.js'
import { withNativeQualificationOwnership } from './modules/harnesses/qualification/nativeOwnership.js'
import { qualificationIdentity, withQualificationIdentity } from './modules/harnesses/qualification/identity.js'
import type { CompatibilityHarness } from '@foreman-code/contracts'
import { NativeHarnessFactories } from './modules/harnesses/runtimeFactory.js'
import type { ProductionHarnessInfrastructure } from './modules/harnesses/productionInfrastructure.js'
import { productionCodexChatFiles, type ProductionCodexChatFiles } from './modules/harnesses/codexFiles/production.js'
import { McpDetectionService } from './modules/harnesses/mcpDetection.js'
import { ExecutionReadinessService } from './modules/harnesses/executionReadiness.js'
import { NativeRollout } from './modules/harnesses/nativeRollout.js'
import type { NativeHarnessSessionManager } from './modules/harnesses/port.js'
import { NativeHarnessConfigurationQualifier } from './modules/harnesses/nativeConfigurationQualifier.js'
import { PostgresAppInteractionService } from './modules/interactions/app.js'
import { PostgresApprovalBudgetRepository } from './modules/interactions/budget.js'
import { ApprovalExecutionCoordinator, type CurrentApprovalExecutionDependencies } from './modules/interactions/execution.js'
import { PostgresWorkflowClosureStore } from './modules/interactions/workflowClosure.js'
import { retryStartupDatabase } from './infrastructure/databaseRetry.js'
import { OperatorInteractionService } from './modules/interactions/operator.js'
import { CurrentInteractionRepository as PostgresInteractionRepository } from './modules/interactions/current/repository.js'
import { InteractionService } from './modules/interactions/service.js'
import { AutomaticReviewService } from './modules/interactions/automaticReview.js'
import { PostgresOperatorRepository } from './modules/operators/postgres.js'
import { LangGraphWorkflowEngine } from './modules/runs/engine.js'
import { RunManagementService } from './modules/runs/management.js'
import { PostgresRunRepository } from './modules/runs/postgres.js'
import { PostgresSettingsRepository } from './modules/settings/postgres.js'
import { PostgresFoundationSettingsRepository } from './modules/settings/foundation.js'
import { FoundationSettingsManagementService } from './modules/settings/management.js'
import { WorkflowManagementService } from './modules/workflows/management.js'
import { PostgresWorkflowRepository } from './modules/workflows/postgres.js'
import { AgentManagementService } from './modules/workspaces/agents.js'
import { requiredLocationAccess, WorkspaceLocationService } from './modules/workspaces/location.js'
import { WorkspaceManagementService } from './modules/workspaces/management.js'
import { PostgresWorkspaceRepository } from './modules/workspaces/postgres.js'
import { RunGraphReadService } from './modules/run-graph/readService.js'
import type { CurrentRunProductionFactory, CurrentRunProductionBinding, CurrentStopContext } from './modules/runs/currentProduction.js'
import type { FastifyBaseLogger } from 'fastify'
import { componentLogger } from './infrastructure/logger.js'
import { ProductionDeviceRuntime } from './modules/devices/productionRuntime.js'
import { ProductionHarnessRegistry } from './modules/harnesses/productionRegistry.js'
import { ProductionHostHarnessProfileQualifier } from './modules/harnesses/productionProfileQualifier.js'
import { HarnessInstanceSettingsRepository } from './modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from './modules/harnesses/instanceSettings/profileRepository.js'
import { HostHarnessInstanceProfileChecks } from './modules/harnesses/instanceSettings/profileChecks.js'
import { HarnessInstallationMonitor } from './modules/harnesses/installationMonitor.js'
import { createInstalledNativeQualificationRetention } from './modules/harnesses/installedNativeQualificationRetention.js'
import { HostHarnessOverrideService, type HostHarnessOverrideAuthority } from './modules/harnesses/instanceSettings/service.js'
import { commandInputHash } from './modules/commands/postgres.js'

/** The native owner supplies slot-specific installation and isolation qualification. */
export type ProductionProviderAccountSelection = AccountNativeSelection & {
  selectAccount?: NonNullable<ConstructorParameters<typeof NativeHarnessFactories>[0]['selectAccount']>
}

type ProductionMainInstallation = Awaited<ReturnType<ProductionDeviceRuntime['initializeFromRuntime']>>
type JobRuntime = Awaited<ReturnType<typeof createProductionJobs>>

export interface ProductionAppOptions {
  config: ApiConfig
  database: ReturnType<typeof createDatabase>
  checkpoints: CheckpointStore
  /** The shared API logger by default; tests pass false. */
  logger?: boolean | FastifyBaseLogger
  createCurrentProduction?: CurrentRunProductionFactory
  /** Trusted FIL-10 admission + execution-host ports; never populated from HTTP fields. */
  codexChatFiles?: ProductionCodexChatFiles
  qualificationSuites?: Record<CompatibilityHarness, QualificationSuite>
  /** Native harness, device and transfer ports. `mode: 'replay'` injects recorded harness protocol. */
  infrastructure?: ProductionHarnessInfrastructure
  accountSelection?: ProductionProviderAccountSelection
  collaborationPorts?: WorkflowFeaturePorts
  /** Keeps harnesses, MCP servers and plugins current on every computer. Only the server entrypoint enables it. */
  computerUpkeep?: boolean
}

/** What the caller passed, with defaults applied. */
interface ProductionBase {
  config: ApiConfig
  database: ReturnType<typeof createDatabase>
  checkpoints: CheckpointStore
  logger: boolean | FastifyBaseLogger
  computerUpkeep: boolean
  createCurrentProduction: CurrentRunProductionFactory | undefined
  codexChatFiles: ProductionCodexChatFiles | undefined
  qualificationSuites: Record<CompatibilityHarness, QualificationSuite> | undefined
  infrastructure: ProductionHarnessInfrastructure | undefined
  accountSelection: ProductionProviderAccountSelection | undefined
  collaborationPorts: WorkflowFeaturePorts | undefined
}

/**
 * Services that code built in an earlier stage reaches before the later stage has built them. Each slot is bound once,
 * by `buildProductionApp`, right after the stage that creates the service returns; the callers only read it when they run.
 */
interface ProductionCallbacks {
  app: Late<ReturnType<typeof buildApp>>
  deviceRuntime: Late<ProductionDeviceRuntime>
  browser: Late<ReturnType<typeof createProductionBrowser>>
  browserRemote: Late<ReturnType<typeof createMainBrowserRemote>>
  workerChats: Late<ReturnType<typeof createProductionWorkerConversations>>
  providerAccounts: Late<ProviderAccountsService>
  harnessRegistry: Late<ProductionHarnessRegistry>
  qualificationRepository: Late<HarnessQualificationRepository>
  selectedSuites: Late<Record<CompatibilityHarness, QualificationSuite> | undefined>
  installationMonitor: Late<HarnessInstallationMonitor>
  runtimeServices: Late<OperatorServices>
  remoteWorkflow: Late<ReturnType<typeof createProductionRemoteWorkflow>>
  nativeConfigurations: Late<NativeConfigurationService>
  harnessInstances: Late<HostHarnessOverrideService>
  hostProfileChecks: Late<HostHarnessInstanceProfileChecks>
  approvals: Late<ApprovalExecutionCoordinator>
  nativeFactories: Late<NativeHarnessFactories>
  runtimeOwner: Late<OperatorRuntimeOwner>
  operatorServices: Late<OperatorServices & { fileRetention: FileRetentionService }>
  shutdown: Late<() => Promise<void>>
}

function createProductionCallbacks(): ProductionCallbacks {
  return {
    app: late('app'),
    deviceRuntime: late('deviceRuntime'),
    browser: late('browser'),
    browserRemote: late('browserRemote'),
    workerChats: late('workerChats'),
    providerAccounts: late('providerAccounts'),
    harnessRegistry: late('harnessRegistry'),
    qualificationRepository: late('qualificationRepository'),
    selectedSuites: late('selectedSuites'),
    installationMonitor: late('installationMonitor'),
    runtimeServices: late('runtimeServices'),
    remoteWorkflow: late('remoteWorkflow'),
    nativeConfigurations: late('nativeConfigurations'),
    harnessInstances: late('harnessInstances'),
    hostProfileChecks: late('hostProfileChecks'),
    approvals: late('approvals'),
    nativeFactories: late('nativeFactories'),
    runtimeOwner: late('runtimeOwner'),
    operatorServices: late('operatorServices'),
    shutdown: late('shutdown'),
  }
}

/** Services that exist only once startup has run, or once file storage is registered. */
interface StartedServices {
  /** Main's installation, once startup has read it. */
  machine?: ProductionMainInstallation
  /** Computer root policies, once Main's own root is bootstrapped. */
  rootPolicies?: WorkspaceRootPolicyPort
  /** Paired-device MCP management, once startup knows Main's installation. */
  managedMcp?: DeviceManagedMcp
  fileStorage?: TemporaryFileService
  files?: ProductionFileStorage
  trustedConnections?: PostgresTrustedConnectionSetup
  jobRuntime?: JobRuntime
  agentPlacement?: AgentPlacementProducer
  agentPreparation?: AgentExecutionPreparation
  executionAuthority?: ReturnType<typeof createExecutionAuthorityExtension>
  workflowArtifacts?: ReturnType<typeof createProductionWorkflowArtifacts>
  workflowPhysicalArtifacts?: PostgresWorkflowPhysicalArtifacts
  artifactComposition?: {
    mainId: string
    authority: PostgresArtifactPublicationAuthority
    fence: PostgresAcceptedArtifactAttemptFence
  }
  mainWorkerMcp?: MainWorkerMcpRelay
  admitWorkflowFileContext?: ReturnType<typeof createProductionWorkflowFileContexts>
  artifactResultSource?: ReturnType<typeof createProductionWorkflowArtifactResultSource>
  artifactOutputsGate?: ReturnType<typeof createWorkflowArtifactOutputsGate>
  localWorkflowArtifacts?: LocalWorkflowArtifacts
  telemetry?: ResourceTelemetryRuntime
  hostCi?: CiServiceClient
  /** Closes the private CI HTTP listener; runs only after the runtime drain, which can still finish Runs. */
  closeCiTransport?: () => Promise<void>
  cloudCis?: CloudCis
}

/** Lifecycle flags and in-flight startup work. */
interface ProductionState {
  closing: boolean
  initialized: boolean
  httpClosing: boolean
  schemaPreparation: Promise<void> | undefined
  initialization: Promise<void> | undefined
  nativeDefaultsInitialization: Promise<void> | undefined
  reconciliation: Promise<void> | undefined
  applicationClose: Promise<void> | undefined
  stopComputerTimers: () => void
  stopSyncTimer: () => void
  stopChatDelivery: (() => void) | undefined
}

type MainTransport = ReturnType<typeof createMainTransport>
type BrowserStage = ReturnType<typeof createBrowser>
type AccountStage = ReturnType<typeof createProviderAccounts>
type RepositoryStage = ReturnType<typeof createWorkflowRepositories>
type QualificationStage = ReturnType<typeof createHarnessQualifications>
type ProfileStage = ReturnType<typeof createHarnessProfiles>
type ManagerStage = ReturnType<typeof createWorkflowManagers>
type ExecutionStage = ReturnType<typeof createExecutionCoordinator>
type ConversationStage = ReturnType<typeof createConversationManagers>
type OperatorChatStage = ReturnType<typeof createOperatorChat>
type AgentChatStage = ReturnType<typeof createAgentChat>
type OperatorStage = ReturnType<typeof createOperatorServices>
type HttpStage = ReturnType<typeof createHttpApplication>
type ControlStage = ReturnType<typeof createRuntimeControl>

/** Everything the startup, shutdown and reconciliation stages work with. */
interface ProductionServices {
  base: ProductionBase
  callbacks: ProductionCallbacks
  started: StartedServices
  runtimeState: ProductionState
  transport: MainTransport
  deviceRuntime: ProductionDeviceRuntime
  browserStage: BrowserStage
  accountStage: AccountStage
  repositoryStage: RepositoryStage
  qualificationStage: QualificationStage
  profileStage: ProfileStage
  managerStage: ManagerStage
  executionStage: ExecutionStage
  conversationStage: ConversationStage
  operatorChatStage: OperatorChatStage
  agentChatStage: AgentChatStage
  operatorStage: OperatorStage
  httpStage: HttpStage
  controlStage: ControlStage
}

/** The startup composition is shared with regression tests; infrastructure owns its lifecycle. */
export function buildProductionApp(options: ProductionAppOptions) {
  const base: ProductionBase = {
    config: options.config,
    database: options.database,
    checkpoints: options.checkpoints,
    logger: options.logger ?? componentLogger('http'),
    computerUpkeep: options.computerUpkeep ?? false,
    createCurrentProduction: options.createCurrentProduction,
    codexChatFiles: options.codexChatFiles,
    qualificationSuites: options.qualificationSuites,
    infrastructure: options.infrastructure,
    accountSelection: options.accountSelection,
    collaborationPorts: options.collaborationPorts,
  }
  const callbacks = createProductionCallbacks()
  const started: StartedServices = {}
  const runtimeState: ProductionState = {
    closing: false,
    initialized: false,
    httpClosing: false,
    schemaPreparation: undefined,
    initialization: undefined,
    nativeDefaultsInitialization: undefined,
    reconciliation: undefined,
    applicationClose: undefined,
    stopComputerTimers: () => {},
    stopSyncTimer: () => {},
    stopChatDelivery: undefined,
  }
  // Each stage is built from the stages before it. Code that must reach a later stage reads it through `callbacks`
  // or, for services that exist only after startup, through `started`.
  const transport = createMainTransport({ base, callbacks, started })
  const deviceRuntime = callbacks.deviceRuntime.bind(createDeviceRuntime({ base, callbacks, started, transport }))
  const browserStage = createBrowser({ base, callbacks, deviceRuntime })
  callbacks.browser.bind(browserStage.browser)
  const accountStage = createProviderAccounts({ base, callbacks, started, transport, deviceRuntime })
  callbacks.providerAccounts.bind(accountStage.providerAccounts)
  const repositoryStage = createWorkflowRepositories({ base, callbacks, started, transport, deviceRuntime, browserStage, accountStage })
  callbacks.remoteWorkflow.bind(repositoryStage.remoteWorkflow)
  callbacks.harnessRegistry.bind(repositoryStage.harnessRegistry)
  callbacks.qualificationRepository.bind(repositoryStage.qualificationRepository)
  callbacks.selectedSuites.bind(repositoryStage.selectedSuites)
  const qualificationStage = createHarnessQualifications({ base, callbacks, transport, accountStage, repositoryStage })
  callbacks.nativeFactories.bind(qualificationStage.nativeFactories)
  const profileStage = createHarnessProfiles({ base, callbacks, started, transport, deviceRuntime, accountStage, repositoryStage, qualificationStage })
  callbacks.nativeConfigurations.bind(profileStage.nativeConfigurations)
  callbacks.harnessInstances.bind(profileStage.harnessInstances)
  callbacks.hostProfileChecks.bind(profileStage.hostProfileChecks)
  callbacks.installationMonitor.bind(profileStage.installationMonitor)
  const managerStage = createWorkflowManagers({ base, started, transport, deviceRuntime, accountStage, repositoryStage, qualificationStage, profileStage })
  const executionStage = createExecutionCoordinator({ base, runtimeState, transport, accountStage, repositoryStage, qualificationStage, profileStage, managerStage })
  callbacks.approvals.bind(executionStage.approvals)
  const conversationStage = createConversationManagers({ base, callbacks, started, transport, deviceRuntime, accountStage, repositoryStage,
    qualificationStage, profileStage, executionStage })
  callbacks.workerChats.bind(conversationStage.workerChats)
  const operatorChatStage = createOperatorChat({ base, transport, deviceRuntime, accountStage, repositoryStage, qualificationStage, profileStage,
    conversationStage })
  const agentChatStage = createAgentChat({ base, callbacks, transport, accountStage, repositoryStage, qualificationStage, profileStage,
    executionStage, conversationStage })
  const operatorStage = createOperatorServices({ base, callbacks, started, runtimeState, transport, deviceRuntime, browserStage, accountStage,
    repositoryStage, qualificationStage, profileStage, managerStage, executionStage, conversationStage, operatorChatStage, agentChatStage })
  callbacks.operatorServices.bind(operatorStage.operatorServices)
  const httpStage = createHttpApplication({ base, started, transport, accountStage, repositoryStage, qualificationStage, profileStage,
    conversationStage, operatorChatStage, operatorStage })
  const { app } = httpStage
  callbacks.app.bind(app)
  callbacks.runtimeServices.bind(httpStage.runtimeServices)
  const controlStage = createRuntimeControl({ base, callbacks, started, runtimeState, transport, deviceRuntime, browserStage, accountStage,
    repositoryStage, qualificationStage, profileStage, managerStage, executionStage, conversationStage, operatorChatStage, agentChatStage, httpStage })
  callbacks.runtimeOwner.bind(controlStage.runtimeOwner)
  const services: ProductionServices = { base, callbacks, started, runtimeState, transport, deviceRuntime, browserStage, accountStage,
    repositoryStage, qualificationStage, profileStage, managerStage, executionStage, conversationStage, operatorChatStage, agentChatStage,
    operatorStage, httpStage, controlStage }
  const { prepareSchema, initialize } = createRuntimeStartup(services)
  const { reconcile, drainShutdown, shutdown } = createRuntimeHooks(services)
  callbacks.shutdown.bind(shutdown)
  return {
    app,
    engine: conversationStage.engine,
    prepareSchema,
    initialize,
    reconcile,
    shutdown,
    drainShutdown,
    rsync: transport.rsync,
    shutdownPending: () => controlStage.lifecycle.pending(),
    registerFileStorage: () => {
      const files = started.files ??= createProductionFileStorage(app, base.database.pool, base.config)
      started.fileStorage = files.service
      controlStage.mountArtifacts()
      registerApiRoutes(app, productionRoutes(httpStage, started))
      return files.service
    },
    startDeviceListener: () => deviceRuntime.startListener(),
  }
}

function createMainTransport({ base, callbacks, started }: {
  base: ProductionBase
  callbacks: ProductionCallbacks
  started: StartedServices
}) {
  const { codexChatFiles, config, database, infrastructure, qualificationSuites } = base
  const mainCodex = new MainCodexSelection(config.harnesses.codexBinary,
    resolve(config.harnesses.workspaceRoot, 'main-codex-selection.json'), systemMaintenancePorts())
  const mainBinaries = { get codexBinary() { return mainCodex.binary } }
  const workerExecution = new WorkerExecutionPolicy(config.workerExecution)
  const harnessHost = createHarnessHost(infrastructure, qualificationSuites)
  const fileStorageRoot = config.fileStorageRoot ?? defaultFileStorageRoot()
  const chatFileAdmissions: ProductionCodexChatFiles = codexChatFiles ?? postgresCodexChatFiles(database.pool, () => {
    if (!started.fileStorage) throw new Error('Production file storage is not registered.')
    return started.fileStorage
  }, () => localCodexChatHost(fileStorageRoot), codexChatHostDirectory(fileStorageRoot))
  const responseJournal = new NativeResponseJournal(resolve(config.harnesses.workspaceRoot, 'native-response-receipts'))
  const processRegistry: NonNullable<ProductionHarnessInfrastructure['auxiliary']>['recovery'] | NativeProcessRegistry = infrastructure?.auxiliary?.recovery
    ?? new NativeProcessRegistry(resolve(config.harnesses.workspaceRoot, 'native-process-registry'))
  const access = new PostgresAccessService(database.pool)
  const inputAcknowledgements = new Map<string, TransferIntent>()
  const acceptedRsync: AcceptedTransferAuthority = createMainTransferAuthority({ pool: database.pool,
    endpoint: () => callbacks.deviceRuntime.get().endpointForDomains(), jobs: () => started.jobRuntime })
  const entrypoint: ReturnType<typeof createMainRsyncEntrypoint> | undefined = infrastructure?.rsyncInstallation?.kind === 'configured' && !infrastructure.rsync
    ? createMainRsyncEntrypoint({ installation: infrastructure.rsyncInstallation, endpoint: () => callbacks.deviceRuntime.get().endpointForDomains(), accepted: acceptedRsync,
      setup: { checkAcceptedTransfer: (...args) => {
        if (!started.trustedConnections) throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'The original Main trusted connection authority has not initialized.', 503)
        return started.trustedConnections.checkAcceptedTransfer(...args)
      }, readAcceptedTransfer: (...args) => {
        if (!started.trustedConnections) throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'Connection consent is unavailable.', 503)
        return started.trustedConnections.readAcceptedTransfer(...args)
      } },
      ownership: () => rsync.kind === 'configured' ? rsync.ownership : undefined }) : undefined
  const installedRsync: InstalledMainRsyncProviders | undefined = infrastructure?.rsync ?? entrypoint?.providers
  const rsyncProviders = installedRsync ? routeMainRsyncAcknowledgements(installedRsync, {
    endpoint: () => callbacks.deviceRuntime.get().endpointForDomains(), jobs: () => started.jobRuntime,
    inputAcknowledgements }) : undefined
  const rsync: ReturnType<typeof createInstalledRsyncComposition> = createInstalledRsyncComposition({ side: 'main', providers: rsyncProviders,
    current: deviceId => callbacks.deviceRuntime.get().endpointForDomains().captureRequest(deviceId, RSYNC_STAGE_EXTENSION.namespace)?.binding })
  const remoteTelemetry = createMainResourceTelemetryBindings(() => started.telemetry?.service)
  return { mainCodex, mainBinaries, workerExecution, harnessHost, fileStorageRoot, chatFileAdmissions, responseJournal, processRegistry, access, inputAcknowledgements, acceptedRsync, entrypoint, installedRsync, rsync, remoteTelemetry }
}

function createDeviceRuntime({ base, callbacks, started, transport }: {
  base: ProductionBase
  callbacks: ProductionCallbacks
  started: StartedServices
  transport: MainTransport
}) {
  const { database, infrastructure } = base
  const { acceptedRsync, remoteTelemetry, rsync } = transport
  const deviceRuntime: ProductionDeviceRuntime = new ProductionDeviceRuntime(database.pool, infrastructure?.deviceListener, {
    workerArtifacts: workerArtifactLocation({ environment: process.env,
      releaseDirectory: fileURLToPath(new URL('../../../', import.meta.url)) }),
    browserMedia: (request, socket, head) => callbacks.browserRemote.get().mediaUpgrade(request, socket, head),
    extensions: [
      remoteTelemetry.extension,
      ...mainRsyncAuthorizationExtensions(rsync.extensions, acceptedRsync),
      { ...BROWSER_DEVICE_EXTENSION, handle: (payload, context) => callbacks.browserRemote.get().handle(payload, context) },
      { namespace: WORKSPACE_ROOT_EXTENSION.namespace, version: WORKSPACE_ROOT_EXTENSION.version, role: 'client', maxJsonBytes: WORKSPACE_ROOT_EXTENSION.maxPayloadBytes, maxBinaryBytes: 0 },
      { ...JOB_RUNTIME_QUALIFICATION_EXTENSION, role: 'duplex', async handle(payload, context) {
        const handler = started.jobRuntime?.qualificationExtension.handle
        if (!handler) throw new DomainError('JOB_RUNTIME_UNAVAILABLE', 'The actual diagnostic qualification authority is unavailable.', 503)
        return handler(payload, context)
      } },
      { ...EXECUTION_AUTHORITY_EXTENSION, role: 'server', async handle(payload, context) {
        if (!started.executionAuthority?.handle) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual Main Agent placement authority has not initialized.', 503)
        return started.executionAuthority.handle(payload, context)
      } },
      { namespace: WORKER_MCP_EXTENSION.namespace, version: WORKER_MCP_EXTENSION.version, role: 'server',
        maxJsonBytes: WORKER_MCP_EXTENSION.maxJsonBytes, maxBinaryBytes: WORKER_MCP_EXTENSION.maxBinaryBytes, async handle(raw, context) {
          const payload = decodeWorkerMcpRequest({ payload: raw, ...(context.bytes ? { bytes: context.bytes } : {}) })
          if (payload && typeof payload === 'object' && 'operation' in payload
            && typeof payload.operation === 'string' && payload.operation.startsWith('conversation-mcp.')) {
            return encodeWorkerMcpResult(await callbacks.workerChats.get().mcp.handle(payload, context.binding, context.signal))
          }
          if (!started.mainWorkerMcp) throw new DomainError('WORKER_MCP_UNAVAILABLE', 'The original Main worker MCP authority has not initialized.', 503)
          context.signal.throwIfAborted()
          const result = await started.mainWorkerMcp.handle(payload, context.binding, context.signal)
          context.signal.throwIfAborted()
          return encodeWorkerMcpResult(result)
        } },
      { ...SOURCE_OPERATION_EXTENSION, role: 'duplex', async handle(payload, context) {
        const handler = started.jobRuntime?.sourceExtension.handle
        if (!handler) throw new DomainError('SOURCE_RUNTIME_UNAVAILABLE', 'The actual Main source domain has not initialized.', 503)
        return handler(payload, context)
      } },
      createMainWorkflowArtifactTransferExtension(() => started.workflowArtifacts?.receiver,
        infrastructure?.deviceDomains?.extensions.find(value => value.namespace === BYTE_TRANSFER_NAMESPACE),()=>started.jobRuntime?.outputs),
      { namespace: 'harness-discovery-v1', version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      createMainProviderAccountExtension({ accounts: () => callbacks.providerAccounts.get(),
        currentBinding: deviceId => deviceRuntime.endpointForDomains().currentBinding(deviceId) }),
      { namespace: COMPUTER_ACCOUNTS_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 65_536, maxBinaryBytes: 0 },
      { namespace: COMPUTER_MAINTENANCE_NAMESPACE, version: COMPUTER_MAINTENANCE_VERSION, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      createProductionWorkerArtifactExtension({
        pool: database.pool,
        environment: process.env,
        releaseDirectory: fileURLToPath(new URL('../../../', import.meta.url)),
      }),
      { namespace: COMPUTER_GITHUB_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 16_384, maxBinaryBytes: 0 },
      { namespace: MANAGED_MCP_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: COMPUTER_SYNC_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: AGENT_SNAPSHOT_NAMESPACE, version: 1, role: 'client', maxJsonBytes: AGENT_SNAPSHOT_JSON_BYTES, maxBinaryBytes: 0 },
      { namespace: CI_RUNTIME_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: CI_HOST_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { namespace: 'host-harness-check-v1', version: 1, role: 'client', maxJsonBytes: 1_048_576, maxBinaryBytes: 0 },
      { ...REMOTE_PREPARATION_EXTENSION, role: 'client' },
      executionExtension({ routes: [
        { matches: payload => WorkerConversationCallbackSchema.safeParse(payload).success, handle: async (payload, context) => {
          if (context.bytes !== undefined) throw new DomainError('WORKER_CONVERSATION_UNAVAILABLE',
            'The Main conversation callback authority is unavailable.', 503)
          return { payload: await callbacks.workerChats.get().bridge.handle(payload, context.binding, context.signal) }
        } },
        { matches: payload => RemoteJobMainRpcRequestRecordSchema.safeParse(payload).success, handle: async (payload, context) => {
          if (!started.jobRuntime) throw new DomainError('JOB_RUNTIME_UNAVAILABLE', 'The actual main Job application bridge is unavailable.', 503)
          return { payload: await started.jobRuntime.application.handle(payload, context.binding) }
        } }],
      dispatch: async (payload, context) => {
        const native = infrastructure?.deviceDomains?.extensions.find(value => value.namespace === REMOTE_EXECUTION_EXTENSION)
        if (!native?.handle) throw new DomainError('REMOTE_WORKFLOW_RPC_UNAVAILABLE', 'The actual main workflow application bridge is unavailable.', 503)
        return native.handle(payload, context)
      } }),
      { namespace: JOB_INPUT_NAMESPACE, version: 1, role: 'server', maxJsonBytes: 1_048_576, maxBinaryBytes: 8192,
        handle: async (payload, context) => {
          const handler = started.jobRuntime?.inputs.extension.handle
          if (!handler) throw new DomainError('JOB_RUNTIME_UNAVAILABLE', 'The actual Job input authority is unavailable.', 503)
          return handler(payload, context)
        } },
      ...(infrastructure?.deviceDomains?.extensions.filter(value => ![REMOTE_EXECUTION_EXTENSION, REMOTE_PREPARATION_EXTENSION.namespace, JOB_INPUT_NAMESPACE, BYTE_TRANSFER_NAMESPACE,
        remoteTelemetry.extension.namespace].includes(value.namespace)) ?? []),
    ],
    async bindingLost(binding) {
      const tasks: Promise<unknown>[] = []
      tasks.push(remoteTelemetry.lost(binding))
      try { if (rsync.kind === 'configured') tasks.push(rsync.rsyncWriters.bindingLost(binding)) } catch (error) { tasks.push(Promise.reject(error)) }
      try { const task = infrastructure?.deviceDomains?.bindingLost?.(binding); if (task) tasks.push(task) } catch (error) { tasks.push(Promise.reject(error)) }
      const results = await Promise.allSettled(tasks), failures = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (failures.length) throw new AggregateError(failures, 'Original device domain binding cleanup remains incomplete')
    },
    async bindingReady(binding, signal, endpoint) {
      const { ci, ciEnrollment, computerSync } = callbacks.runtimeServices.get()
      if (!signal.aborted) {
        callbacks.browser.get().profiles.wake()
        started.jobRuntime?.requestQueueWake()
        ciEnrollment?.request({
          hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
          applicationInstallationId: binding.workerInstallationId,
          keyRevision: binding.keyRevision, authorizationRevision: binding.authorizationRevision,
        })
        void ci?.dispatch().catch(error => callbacks.app.get().log.error({ err: error }, 'CI dispatch failed'))
      }
      if (computerSync) {
        void computerSync.paired({
          hostRef: { kind: 'device', mainId: binding.mainId, deviceId: binding.deviceId },
          applicationInstallationId: binding.workerInstallationId,
          keyRevision: binding.keyRevision, authorizationRevision: binding.authorizationRevision,
        }).catch(error => callbacks.app.get().log.warn({ err: error, deviceId: binding.deviceId }, 'Shared file pairing is pending'))
      }
      callbacks.installationMonitor.get().workerReady(binding, signal)
      try {
        const session = await remoteTelemetry.ready(binding, signal, endpoint)
        if (session) void session.completion.catch(error => {
          if (!signal.aborted) callbacks.app.get().log.error({ err: error, deviceId: binding.deviceId }, 'Remote resource telemetry collector failed')
        })
      } catch (error) {
        if (!signal.aborted) callbacks.app.get().log.error({ err: error, deviceId: binding.deviceId }, 'Remote resource telemetry collector did not start')
      }
    },
    async reconcile(binding, signal, endpoint) {
      if (endpoint.capabilities(binding.deviceId).some((item) => item.namespace === 'harness-discovery-v1' && item.mainCanRequest)) {
        const result = await endpoint.request(binding.deviceId, 'harness-discovery-v1',
          { operation: 'discover', refreshId: randomUUID() }, { signal })
        signal.throwIfAborted()
        const selectedSuites = callbacks.selectedSuites.get()
        if (selectedSuites) await retainInstalledHarnessInventory({ registry: callbacks.harnessRegistry.get(), qualifications: callbacks.qualificationRepository.get(),
          binding, inventory: result.payload, suiteRevision: selectedSuites.codex.revision })
        else callbacks.harnessRegistry.get().acceptRemoteSnapshot(binding, result.payload)
      }
      if (infrastructure?.deviceDomains) await infrastructure.deviceDomains.reconcile(binding, signal, endpoint)
    },
  })
  return deviceRuntime
}

function createBrowser({ base, callbacks, deviceRuntime }: {
  base: ProductionBase
  callbacks: ProductionCallbacks
  deviceRuntime: ProductionDeviceRuntime
}) {
  const { config, database } = base
  const reportFailure = (error: unknown) => componentLogger('harness').warn({ err: error }, 'Browser runtime requires attention')
  const browser = createProductionBrowser({ pool: database.pool,
    stateDirectory: config.browserStateDirectory ?? resolve(config.harnesses.workspaceRoot, 'browser-state'),
    runtimeRoot: config.browserRuntimeRoot,
    binding: id => deviceRuntime.currentBinding(id),
    assertHostOwnership: async () => {
      if (!callbacks.runtimeOwner.get().active) throw new DomainError('NATIVE_RUNTIME_UNAVAILABLE', 'The browser runtime owner is unavailable.', 503)
    }, reportFailure,
    remote: (pairing, authority) => {
      const remote = createMainBrowserRemote({ pool: database.pool, pairing, authority,
        endpoint: () => deviceRuntime.endpointForDomains(), browser: () => callbacks.browser.get(), reportFailure })
      return callbacks.browserRemote.bind(remote)
    },
  })
  const collaborationPorts: WorkflowFeaturePorts = { ...base.collaborationPorts, browser: browser.lifecycle }
  return { browser, collaborationPorts }
}

function createProviderAccounts({ base, callbacks, started, transport, deviceRuntime }: {
  base: ProductionBase
  callbacks: ProductionCallbacks
  started: StartedServices
  transport: MainTransport
  deviceRuntime: ProductionDeviceRuntime
}) {
  const { accountSelection, config, database } = base
  const { processRegistry } = transport
  const commands = new PostgresCommandCoordinator(database.pool)
  const bugReports = new BugReportService(database.pool, commands)
  const accountCredentials = new LocalProviderCredentials(resolve(config.harnesses.workspaceRoot, 'provider-accounts'))
  const selectedAccounts: ProductionProviderAccountSelection = accountSelection ?? createProductionAccountSelection({
    path: resolve(config.harnesses.workspaceRoot, 'provider-account-qualifications.json'),
    managedPaths: accountId => accountCredentials.paths(accountId),
    validate: () => callbacks.harnessRegistry.get().refreshMain(),
    pin: record => callbacks.harnessRegistry.get().pinOverride(record.override),
    models: async (binding, generation) => {
      const options = await callbacks.nativeConfigurations.get().options(binding.provider, binding)
      const selected = selectedAccounts.selectAccount?.(binding)
      if (!selected) throw new DomainError('PROVIDER_ACCOUNT_UNQUALIFIED', 'Account model installation is unavailable.', 409)
      return { binding, generation, observedAt: options.checkedAt,
        models: options.models.map(row => ({ ...row, name: row.name ?? row.id })), options }
    },
  })
  const accountCommands = new NativeProviderAccountCommands(selectedAccounts)
  const accountNative: NativeProviderAccountOperations | NativeProviderAccountCommands = processRegistry instanceof NativeProcessRegistry
    ? new NativeProviderAccountOperations(accountCommands,
      new NativeAccountJournal(resolve(config.harnesses.workspaceRoot, 'provider-account-operations')), processRegistry,
      input => providerAccounts.assertAuthenticationEligibility(input.operation))
    : accountCommands
  // Main's own accounts belong to its installation: read from the database until startup knows it.
  const mainTarget = async (sql: Parameters<typeof readMainProvisioningTarget>[0]) => started.machine
    ? mainProvisioningTarget(started.machine.installationId) : readMainProvisioningTarget(sql)
  const providerAccounts: ProviderAccountsService = new ProviderAccountsService(database.pool,
    new ProviderAccountsRepository(database.pool, () => accountCredentials.hostId(), mainTarget), accountCredentials,
    accountNative, commands, undefined, local => createRemoteAccountServices({ pool: database.pool, commands, local,
      endpoint: () => deviceRuntime.endpointForDomains() }))
  const workflowAccountBindings = new Map<string, AcceptedProviderAccountBinding>()
  const accountConfigurations = new ProviderAccountConfigurationService(providerAccounts, {
    selectionForConfiguration: (...args) => callbacks.harnessInstances.get().selectionForConfiguration(...args),
    prepareOperatorConfiguration: (...args) => callbacks.harnessInstances.get().prepareOperatorConfiguration(...args),
    validateSelection: (...args) => callbacks.harnessInstances.get().validateSelection(...args),
  })
  const workflowCapture = createWorkflowNativeCaptureChannel()
  const reviewCapture = createReviewNativeCaptureChannel()
  const memoryBoards = createMemoryBoardService(database.pool, memoryBoardAuthority)
  const workflowRuntime = createWorkflowRepositoryServices(workflowCapture.verify, (sql, owner, capture) => {
    return callbacks.remoteWorkflow.get().assertPhysical(sql, owner, capture)
  }, async (sql, evidence, proof) => {
    // Event file contexts are admitted at turn start; artifact results arrive in captured history.
    if (proof.original.type === 'event' && proof.original.event.type !== 'turn.started') return
    if (!started.admitWorkflowFileContext) throw new DomainError('NATIVE_ARTIFACT_CONTEXT_UNAVAILABLE', 'The original Main file-context composition is unavailable.', 503)
    await started.admitWorkflowFileContext(sql, evidence, proof)
    if (await workflowArtifactsAreLocal(sql, proof.scope.runId, proof.ref.nodeId)) {
      const snapshot = await readAcceptedRepeatRunLocked(sql, proof.scope.runId)
      const node = snapshot.version.definition.nodes.find(item => item.id === proof.ref.nodeId)
      if (node && node.kind !== 'job' && node.artifactOutputs) {
        if (!started.localWorkflowArtifacts) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
          'Local workflow artifact storage is unavailable.', 503)
        await started.localWorkflowArtifacts.admitContextLocked(sql, workflowCapture.verify.read(evidence), proof)
      }
      return
    }
    await started.artifactResultSource?.retainOriginalLocked(sql, evidence, proof)
  })
  return { commands, bugReports, selectedAccounts, providerAccounts, workflowAccountBindings, accountConfigurations, workflowCapture, reviewCapture, memoryBoards, workflowRuntime }
}

function createWorkflowRepositories({ base, callbacks, started, transport, deviceRuntime, browserStage, accountStage }: {
  base: ProductionBase
  callbacks: ProductionCallbacks
  started: StartedServices
  transport: MainTransport
  deviceRuntime: ProductionDeviceRuntime
  browserStage: BrowserStage
  accountStage: AccountStage
}) {
  const { config, database, infrastructure, qualificationSuites } = base
  const { mainBinaries, processRegistry, workerExecution } = transport
  const { collaborationPorts } = browserStage
  const { accountConfigurations, commands, memoryBoards, reviewCapture, workflowCapture, workflowRuntime } = accountStage
  const workflowCollaboration = new WorkflowCollaborationIntegration(
    collaborationPorts, async (owner, execution) => {
      const placement = await owner.oneShotConnection().transaction(sql =>
        readAcceptedPlacement(sql, execution.runId, execution.workflowNodeId), true)
      if (placement) return placement.hostRef.kind === 'device' ? placement.hostRef.deviceId : placement.hostRef.mainId
      const mainId = started.artifactComposition?.mainId
      if (!mainId) throw new DomainError('BROWSER_COMPUTER_UNAVAILABLE', 'The accepted Main computer is unavailable.', 503)
      return mainId
    })
  const workflowServices: RepeatRepositoryServices = { ...workflowRuntime.services,
    collaboration: workflowCollaboration.hooks,
    prepareCollaborationExecution: (owner, run, version, execution) => workflowCollaboration.prepare(owner, run, version, execution),
    readCollaborationPrompt: (owner, execution, version) => workflowCollaboration.readPrompt(owner, execution, version),
    releaseCollaborationExecution: (owner, execution, version) => workflowCollaboration.release(owner, execution, 'terminal', version),
    memoryBoards,
    async reconcileWorkflowArtifacts(owner, run, execution, signal) {
      signal.throwIfAborted()
      const snapshot = await runs.getRepeatSnapshot(run.id, owner)
      const node = snapshot.version.definition.nodes.find((item) => item.id === execution.workflowNodeId)
      if (!node || node.kind === 'job' || !node.artifactOutputs) return
      if (await workflowArtifactsAreLocal(database.pool, execution.runId, execution.workflowNodeId)) {
        if (!started.localWorkflowArtifacts) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
          'Local workflow artifact storage is unavailable.', 503)
        await started.localWorkflowArtifacts.recover(owner, execution, signal)
        return
      }
      if (!started.artifactComposition || !started.workflowArtifacts) {
        throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The original artifact composition is unavailable.', 503)
      }
      await recoverWorkflowArtifactOutputs({ owner, execution, authority: started.artifactComposition.authority,
        outputs: started.workflowArtifacts.artifacts.outputs })
    },
    async assertWorkflowArtifactOutputsLocked(sql, run, version, execution) {
      if (await workflowArtifactsAreLocal(sql, execution.runId, execution.workflowNodeId)) {
        if (!started.localWorkflowArtifacts) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
          'Local workflow artifact storage is unavailable.', 503)
        await started.localWorkflowArtifacts.assertOutputsLocked(sql, run, version, execution)
        return
      }
      if (!started.artifactOutputsGate) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The original workflow artifact acceptance composition is unavailable.', 503)
      await started.artifactOutputsGate(sql, run, version, execution)
    },
    async admitPlacementExecutionLocked(sql, owner, run, execution, ref, inputDigest) {
      if (started.agentPlacement) { await started.agentPlacement.admitExecution(sql, owner, execution, ref, inputDigest, run.authorizationPrincipalId); return }
      if (await readAcceptedPlacement(sql, run.id, execution.workflowNodeId)) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual Agent placement producer is unavailable.', 503)
    },
    async preparePlacementExecution(owner, run, execution) {
      const { artifactResultSource, agentPreparation } = started
      if (!artifactResultSource) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The original workflow artifact composition is unavailable.', 503)
      await owner.oneShotConnection().transaction(sql => artifactResultSource.assertLaunchDeclarationLocked(sql, execution.id, run.id))
      if (agentPreparation) {
        const prepared = await callbacks.approvals.get().withSourceObservationLane(owner, execution, () => agentPreparation.prepare(owner, run, execution))
        if (prepared) return { ...prepared, revalidate: () => callbacks.approvals.get().withSourceObservationLane(owner, execution, prepared.revalidate) }
      }
      const placed = await owner.oneShotConnection().transaction(sql => readAcceptedPlacement(sql, run.id, execution.workflowNodeId))
      if (placed) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual Agent source preparation producer is unavailable.', 503)
      await locations.revalidateRunAuthorization(run.authorizationPrincipalId, run.workspaceId, run.workflowId, owner.client)
      const configuration = await workflows.getAgentConfiguration(execution.agentConfigurationVersionId)
      if (!configuration) throw new DomainError('AGENT_CONFIGURATION_NOT_FOUND', 'The accepted Agent configuration is unavailable.', 409)
      const access = requiredLocationAccess([configuration])
      await locations.revalidateSnapshot(run.workspaceId, run.executionLocation, access)
      const tree = await runWorktrees.prepare(run, AbortSignal.timeout(60_000), execution.id)
      if (!tree) return undefined
      return { workingDirectory: tree.workingDirectory,
        runtimeDirectory: repeatRuntimeDirectory(config.harnesses.workspaceRoot, { workspaceId: run.workspaceId,
          workflowId: run.workflowId, workflowVersionId: run.workflowVersionId, runId: run.id, executionSemanticsVersion: 3 }, execution),
        revalidate: async () => {
          owner.assertOwned()
          await locations.revalidateSnapshot(run.workspaceId, run.executionLocation, access)
          await runWorktrees.verify(tree)
        } }
    },
  }
  const reviewNativeProofs = new ReviewNativeProofServices(reviewCapture.verify,
    (sql, capture) => remoteWorkflow.assertReviewPhysical(sql, capture))
  const repository = new PostgresInteractionRepository(database.pool, reviewNativeProofs)
  const budgets = new PostgresApprovalBudgetRepository(database.pool)
  const projectRoot = config.workspaceStorageRoot ?? workspaceStorageRoot()
  const runWorktrees = new RunWorktrees(database.pool, join(config.harnesses.workspaceRoot, 'run-worktrees'))
  const locations = new WorkspaceLocationService(database.pool, commands, config.harnesses.workspaceRoot, 'runner-local',
    () => started.rootPolicies)
  const workflows = new PostgresWorkflowRepository(database.pool)
  const runs = new PostgresRunRepository(database.pool, workflows, locations,
    { runtimeRoot: config.harnesses.workspaceRoot, ...workflowRuntime, services: workflowServices }, async evidence => {
      const accepted = started.artifactResultSource?.acceptedAfterCommit(evidence)
      if (accepted) {
        if (!started.workflowArtifacts || !started.artifactResultSource) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The original workflow artifact composition is unavailable.', 503)
        await new WorkflowArtifactResultAdoption(started.artifactResultSource.source, started.workflowArtifacts.artifacts.outputs).adoptOriginalOutputs(accepted)
        await started.artifactResultSource.assertAdoptedAfterCommit(evidence)
      }
      try { await remoteWorkflow.afterCommit(workflowCapture.verify.read(evidence)) }
      catch (error) { callbacks.app.get().log.warn({ err: error }, 'Original remote metadata acknowledgment remains pending') }
    })
  const remoteWorkflow = createProductionRemoteWorkflow({ pool: database.pool, locations, endpoint: () => deviceRuntime.endpointForDomains(),
    preparationTimeoutMs: config.harnesses.timeoutMs,
    workerExecution,
    producer: () => started.agentPlacement, execution: id => runs.getExecution(id), artifacts: {
      assertPublications: (sql, readout, binding) => {
        if (!started.workflowPhysicalArtifacts) throw new DomainError('REMOTE_ARTIFACT_PHYSICAL_UNAVAILABLE', 'The original canonical artifact physical composition is unavailable.', 503)
        return started.workflowPhysicalArtifacts.assertPublications(sql, readout, binding)
      },
      assertAdopted: (sql, readout, binding) => {
        if (!started.workflowPhysicalArtifacts) throw new DomainError('REMOTE_ARTIFACT_PHYSICAL_UNAVAILABLE', 'The original canonical artifact physical composition is unavailable.', 503)
        return started.workflowPhysicalArtifacts.assertAdopted(sql, readout, binding)
      },
    } })
  const workspaces = new PostgresWorkspaceRepository(database.pool, workflows, runs)
  const settings = new PostgresSettingsRepository(database.pool)
  const hostProfileEvidence = new HostHarnessProfileEvidenceRepository(database.pool)
  const claudeDiscovery: ReturnType<typeof createClaudeProductionDiscovery> = createClaudeProductionDiscovery({ registry: () => harnessRegistry, factories: () => callbacks.nativeFactories.get(),
    workingDirectory: config.harnesses.workspaceRoot })
  const harnessRegistry: ProductionHarnessRegistry = new ProductionHarnessRegistry(database.pool, mainBinaries,
    (client) => settings.getManagedHarnessDefaults(client), hostProfileEvidence,
    (deviceId) => { const view = deviceRuntime.presenceFor(deviceId); return view?.phase === 'ready' ? view.binding : null },
    process.env, infrastructure?.inventoryDiscovery ?? { launcher: discoverInventoryLauncher, payloads: inventoryDriverPayloads,
      claude: claudeDiscovery.discover }, (deviceId) => deviceRuntime.currentBinding(deviceId),
    (deviceId) => deviceRuntime.presenceFor(deviceId))
  const foundationSettings = new PostgresFoundationSettingsRepository(database.pool, projectRoot)
  const remoteExecution = new RemoteExecutionSettingsService(foundationSettings, commands, workerExecution,
    deviceRuntime, remoteExecutionStartupEnvironment({ listener: infrastructure?.deviceListener,
      workerExecution: config.workerExecution, environment: config.remoteExecutionEnvironment ?? {} }), config.port,
    error => callbacks.app.get().log.error({ err: error }, 'device listener settings could not be applied'))
  const operators = new PostgresOperatorRepository(database.pool, accountConfigurations)
  const rollout = new NativeRollout(process.env)
  const compatibilityProbe = (timeoutMs = 2000, expected?: { harness: CompatibilityHarness; binary: string }) => scopedCompatibilityProbe({
    registry: processRegistry, pin: (harness) => {
      const binding = harnessRegistry.pinDefault(harness)
      if (expected && (harness !== expected.harness || binding.installation.launcher.resolvedLauncher !== expected.binary)) {
        throw new DomainError('HARNESS_INSTALLATION_CHANGED', 'Diagnostics require the original inspected launcher.', 409)
      }
      return binding
    },
    assertInstallation: (binding, signal) => callbacks.nativeFactories.get().assertInstallationUnchanged(binding, signal),
    workingDirectory: config.harnesses.workspaceRoot, environment: process.env, timeoutMs,
  })
  const qualificationRepository = new HarnessQualificationRepository(database.pool)
  const identity = infrastructure?.qualificationIdentity ?? {
    registry: harnessRegistry.installations, pin: (harness: CompatibilityHarness) => harnessRegistry.pinDefault(harness),
  }
  const selectedSuites: Record<CompatibilityHarness, QualificationSuite> | undefined = qualificationSuites && identity ? {
    codex: withQualificationIdentity(withNativeQualificationOwnership(qualificationSuites.codex, processRegistry,
      (input) => { const binding = identity.pin('codex', input); return (signal) => callbacks.nativeFactories.get().assertInstallationUnchanged(binding, signal) }), identity.registry, (input) => identity.pin('codex', input)),
  } : qualificationSuites
  return { workflowCollaboration, repository, budgets, projectRoot, runWorktrees, locations, workflows, runs, remoteWorkflow, workspaces, settings, hostProfileEvidence, claudeDiscovery, harnessRegistry, foundationSettings, remoteExecution, operators, rollout, compatibilityProbe, qualificationRepository, selectedSuites }
}

function createHarnessQualifications({ base, callbacks, transport, accountStage, repositoryStage }: {
  base: ProductionBase
  callbacks: ProductionCallbacks
  transport: MainTransport
  accountStage: AccountStage
  repositoryStage: RepositoryStage
}) {
  const { config, database, infrastructure } = base
  const { access, harnessHost, mainCodex, processRegistry, responseJournal } = transport
  const { commands, providerAccounts, selectedAccounts } = accountStage
  const { claudeDiscovery, compatibilityProbe, harnessRegistry, hostProfileEvidence, qualificationRepository, selectedSuites, settings } = repositoryStage
  const qualificationRegistry = selectedSuites ? new HarnessQualificationRegistry(qualificationRepository, {
    codex: selectedSuites.codex.revision,
  }) : undefined
  const harnessQualifications = selectedSuites && qualificationRegistry ? new HarnessQualificationService(
    qualificationRepository, qualificationRegistry, selectedSuites,
    { get codex() { return mainCodex.binary } }, commands, settings,
    undefined, (harness) => harnessCompatibility.refreshAfterQualification(harness),
    (harness, binary, timeoutMs) => compatibilityProbe(timeoutMs, { harness, binary }),
    (harness, signal) => {
      if (harness !== 'codex') throw new DomainError('HARNESS_DRIVER_UNAVAILABLE', 'Unsupported qualification driver.', 409)
      return harnessRegistry.refreshMain(signal)
    },
    harness => commandInputHash(qualificationIdentity(harnessRegistry.pinDefault(harness), selectedSuites[harness].revision)),
  ) : undefined
  const harnessCompatibility = infrastructure?.auxiliary
    ? new HarnessCompatibilityService({ ...infrastructure.auxiliary.compatibility, commands })
    : new HarnessCompatibilityService({ probe: compatibilityProbe(), cache: new FileCompatibilityCache(), commands })
  const endpointHost = config.host === '0.0.0.0' ? '127.0.0.1'
    : config.host === '::' || config.host === '::1' ? '[::1]' : config.host
  const appMcpEndpoint = `http://${endpointHost}:${config.port}/mcp`
  const nativeFactories = new NativeHarnessFactories({ get codexBinary() { return mainCodex.binary }, responseJournal,
    accounts: providerAccounts,
    ...(selectedAccounts.selectAccount ? { selectAccount: selectedAccounts.selectAccount } : {}),
    refreshInstallations: signal => harnessRegistry.refreshMain(signal),
    instances: harnessRegistry.instances, installations: harnessRegistry.installations,
    selectDefault: (harness) => harnessRegistry.pinDefault(harness),
    selectConfiguration: (configuration) => harnessRegistry.pinAccepted({
      id: `configuration-check:${commandInputHash(configuration)}`, agentId: 'configuration-qualification', harness: configuration,
    }),
    ...(infrastructure?.inventoryDiscovery ? { installationDiscovery: infrastructure.inventoryDiscovery.launcher } : {}),
    auxiliaryRecovery: (role) => processRegistry.scope(`${role}:${harnessHost.auxiliaryLaunchId()}`),
    admitRecovery: async (recovery) => { Object.assign(recovery, await processRegistry.reserveLaunch(recovery.owner)) },
    abandonRecovery: async (recovery) => { await processRegistry.abandonReservedLaunch(recovery) },
    claudeVersionCommand: infrastructure?.auxiliary?.command ?? runCommand,
    closeRecovery: async (recovery) => {
      if (!await processRegistry.closeOwner(recovery.owner)) throw new Error('Diagnostic native process closure is unconfirmed.')
    },
  }, infrastructure)
  const hostSettings = new HarnessInstanceSettingsRepository(database.pool)
  const hostAuthority: HostHarnessOverrideAuthority = deviceHostOverrideAuthority(database.pool)
  const profileAuthority: AcceptedProfileAuthority<ClaudeProfileOwner> = createProductionProfileAuthority({ access, providerAccounts, registry: harnessRegistry,
    evidence: hostProfileEvidence,
    claudeCurrent: () => infrastructure?.claudeCurrentProfile
      ?? (harnessHost.installedClis ? claudeDiscovery.current : undefined),
    checks: () => callbacks.hostProfileChecks.get() })
  return { qualificationRegistry, harnessQualifications, harnessCompatibility, appMcpEndpoint, nativeFactories, hostSettings, hostAuthority, profileAuthority }
}

function createHarnessProfiles({ base, callbacks, started, transport, deviceRuntime, accountStage, repositoryStage, qualificationStage }: {
  base: ProductionBase
  callbacks: ProductionCallbacks
  started: StartedServices
  transport: MainTransport
  deviceRuntime: ProductionDeviceRuntime
  accountStage: AccountStage
  repositoryStage: RepositoryStage
  qualificationStage: QualificationStage
}) {
  const { config, database, infrastructure } = base
  const { harnessHost, mainCodex, processRegistry, workerExecution } = transport
  const { accountConfigurations, commands, providerAccounts, selectedAccounts } = accountStage
  const { claudeDiscovery, harnessRegistry, hostProfileEvidence, projectRoot, qualificationRepository, selectedSuites, settings } = repositoryStage
  const { appMcpEndpoint, harnessQualifications, hostAuthority, hostSettings, nativeFactories, profileAuthority } = qualificationStage
  const selectedProfiles = new AcceptedHarnessProfileAdmission<ClaudeProfileOwner>(hostSettings, hostProfileEvidence, profileAuthority)
  const claudeProfiles: AcceptedClaudeProfileAdmission<ClaudeProfileOwner> = infrastructure?.claudeProfiles ?? new AcceptedClaudeProfileAdmission<ClaudeProfileOwner>(hostSettings, hostProfileEvidence, profileAuthority)
  const hostProfileChecks = new HostHarnessInstanceProfileChecks(hostSettings, hostProfileEvidence, commands, hostAuthority,
    new ProductionHostHarnessProfileQualifier(harnessRegistry, nativeFactories, () => deviceRuntime.endpointForDomains(), config.harnesses.workspaceRoot,
      !harnessHost.installedClis ? undefined : { async qualify(value, input) {
        const apiKey = await requireClaudeProductionCredentialDelivery(value.configuration, providerAccounts, value.target.hostRef,
          value.target.applicationInstallationId)
        const current = await claudeDiscovery.currentForConfiguration(value, input.signal)
        const binding = harnessRegistry.pinOverride(value)
        const recovery = await processRegistry.reserveLaunch(`claude-profile-check:${input.checkId}`)
        const close = async () => {
          await processRegistry.abandonReservedLaunch(recovery)
          if (!await processRegistry.closeOwner(recovery.owner)) throw new Error('Claude native profile qualification closure is unconfirmed.')
        }
        try { return await qualifyClaudeNativeProfile({ value, checkId: input.checkId, binding, pin: current.pin,
          ...(apiKey ? { apiKey } : {}),
          directory: resolve(config.harnesses.workspaceRoot, 'claude-native-qualification'), recovery, signal: input.signal,
          assertCurrent: async () => { await nativeFactories.assertInstallationUnchanged(binding, input.signal); harnessRegistry.installations.assertCurrent(binding) } }) }
        finally { await close() }
      } }, workerExecution, providerAccounts), selectedSuites ? createInstalledNativeQualificationRetention({
      repository: qualificationRepository, suiteRevision: selectedSuites.codex.revision,
      currentBinding: deviceId => deviceRuntime.endpointForDomains().captureRequest(deviceId, 'host-harness-check-v1')?.binding ?? null,
      currentInstallation: value => harnessRegistry.pinOverride(value).installation,
      async refreshInstallation(value, signal) {
        if (value.target.hostRef.kind !== 'device') return
        const captured = deviceRuntime.endpointForDomains().captureRequest(value.target.hostRef.deviceId, 'harness-discovery-v1')
        if (!captured) throw new DomainError('HARNESS_INVENTORY_STALE', 'The qualified Worker connection is unavailable.', 409)
        const bounded = AbortSignal.any([signal, AbortSignal.timeout(30000)])
        const result = await captured.request({ operation: 'discover', refreshId: randomUUID() }, { signal: bounded })
        bounded.throwIfAborted()
        await retainInstalledHarnessInventory({ registry: harnessRegistry, qualifications: qualificationRepository,
          binding: captured.binding, inventory: result.payload, suiteRevision: selectedSuites.codex.revision })
      },
    }) : undefined)
  const harnessInstances = new HostHarnessOverrideService(hostSettings, commands, hostAuthority, async (value, client) => {
    await requireClaudeProductionCredentialDelivery(value.configuration, providerAccounts, value.target.hostRef,
          value.target.applicationInstallationId)
    const proof = await harnessRegistry.profileEvidence(value, client, { includeFailed: true })
    return proof ? { target: proof.target, configurationFingerprint: proof.configurationFingerprint,
      qualified: proof.qualified, ...(proof.failure ? { failure: proof.failure } : {}) } : null
  }, hostProfileChecks, configuration => {
    const binding = harnessRegistry.pinAccepted({ id: `operator-default-profile:${commandInputHash(configuration)}`, agentId: 'operator-default-setup', harness: configuration })
    const hostRef = binding.selection.hostRef
    if (hostRef.kind !== 'main' || !binding.installation.installationFingerprint) throw new DomainError('CLAUDE_INSTALLATION_UNAVAILABLE', 'The actual local Claude installation is unavailable.', 409)
    return { hostRef, applicationInstallationId: hostRef.mainId, harnessInstallationId: binding.selection.harnessInstallationId,
      installationFingerprint: binding.installation.installationFingerprint }
  }, accountConfigurations, value => hostProfileChecks.checkAutomatically(
    value, harnessRegistry.pinOverride(value).installation,
  ))
  const installationMonitor = new HarnessInstallationMonitor(harnessRegistry, hostProfileChecks,
    () => deviceRuntime.endpointForDomains(), async (binding, inventory) => {
      if (selectedSuites) await retainInstalledHarnessInventory({ registry: harnessRegistry,
        qualifications: qualificationRepository, binding, inventory, suiteRevision: selectedSuites.codex.revision })
      else harnessRegistry.acceptRemoteSnapshot(binding, inventory)
    }, async () => {
      if (!harnessQualifications) return
      const result = await harnessQualifications.verify('codex', { force: true })
      if (result.status === 'qualified') return
      // A signed-out Codex cannot run the check's model turn. That is the owner's sign-in to do, not a fault.
      if (await nativeConfigurations.options('codex').then(() => false, harnessSignInRequired)) {
        throw new DomainError('HARNESS_SIGN_IN_REQUIRED', 'Sign in to Codex on the server; its updated installation is checked after sign-in.',
          409, { signInRequired: true })
      }
      throw new DomainError('HARNESS_REQUALIFICATION_FAILED',
        result.failureReason ?? 'The updated Codex installation failed its native checks.', 409)
    }, error => {
      if (onlySignInRequired(error)) callbacks.app.get().log.warn({ err: error }, 'Automatic harness installation checks wait for sign-in')
      else if (isDatabasePoolTimeout(error)) callbacks.app.get().log.warn({ err: error }, 'Automatic harness installation checks retry after a busy database')
      else callbacks.app.get().log.error({ err: error }, 'Automatic harness installation checks failed')
    },
    infrastructure?.installationRefreshIntervalMs)
  const claudeMetadata = !harnessHost.installedClis ? undefined : productionClaudeMetadata({ registry: harnessRegistry,
    accounts: providerAccounts,
    ...(selectedAccounts.selectAccount ? { selectAccount: selectedAccounts.selectAccount } : {}),
    processes: processRegistry, factories: nativeFactories, settings: hostSettings, defaults: () => settings.getHarnessDefaults(), current: claudeDiscovery.currentForConfiguration })
  const qualifier = new NativeHarnessConfigurationQualifier(config.harnesses.codexBinary, nativeFactories, claudeMetadata, providerAccounts)
  const harnessCatalog = new HarnessCatalogService(qualifier, settings, commands, config.harnesses.workspaceRoot, appMcpEndpoint)
  const nativeConfigurations = new NativeConfigurationService(
    config.harnesses.codexBinary, config.harnesses.workspaceRoot, nativeFactories, claudeMetadata, providerAccounts,
    { mainId: async () => await readMainInstallationId(database.pool) ?? '',
    endpoint: () => deviceRuntime.endpointForDomains() },
  )
  const appRoutes = new AppMcpRoutes(database.pool, appMcpEndpoint, appLauncherPath(), () => callbacks.runtimeOwner.get())
  const maintenancePorts = systemMaintenancePorts(process.env, { get codex() { return mainCodex.binary } })
  maintenancePorts.selectInstalledCodex = async signal => {
    const binary = await mainCodex.selectInstalled(signal)
    await harnessRegistry.refreshMain(signal)
    harnessCatalog.invalidateChecks()
    nativeConfigurations.invalidateOptions()
    return binary
  }
  const harnessSettings = {
    claudePlugins: new ClaudePluginSettingsService(maintenancePorts, commands),
    directories: new HarnessDirectoryBrowser([projectRoot], database.pool),
    plugins: new CodexPluginSettingsService(database.pool, infrastructure?.auxiliary?.plugins ?? new NativeCodexPlugins(() => mainCodex.binary, config.harnesses.workspaceRoot,
      processRegistry.scope('settings:plugins:codex')), () => processRegistry.closeOwner('settings:plugins:codex')),
    mcp: new HarnessMcpSettingsService(database.pool, commands, {
      codex: infrastructure?.auxiliary?.mcp.codex ?? new CodexMcpConnections(() => mainCodex.binary, config.harnesses.workspaceRoot, processRegistry.scope('settings:mcp:codex')),
    }, () => { harnessCatalog.invalidateChecks(); nativeConfigurations.invalidateOptions() }, async () => {
      await processRegistry.closeOwner('settings:mcp:codex')
    }, appMcpEndpoint, () => started.managedMcp),
  }
  const launches = new NativeLaunchRecords()
  return { selectedProfiles, claudeProfiles, hostProfileChecks, harnessInstances, installationMonitor, harnessCatalog, nativeConfigurations, appRoutes, maintenancePorts, harnessSettings, launches }
}

function createWorkflowManagers({ base, started, transport, deviceRuntime, accountStage, repositoryStage, qualificationStage, profileStage }: {
  base: ProductionBase
  started: StartedServices
  transport: MainTransport
  deviceRuntime: ProductionDeviceRuntime
  accountStage: AccountStage
  repositoryStage: RepositoryStage
  qualificationStage: QualificationStage
  profileStage: ProfileStage
}) {
  const { database, infrastructure } = base
  const { access, fileStorageRoot, harnessHost, processRegistry } = transport
  const { providerAccounts, workflowAccountBindings } = accountStage
  const { harnessRegistry, locations, remoteWorkflow, runs } = repositoryStage
  const { nativeFactories } = qualificationStage
  const { claudeProfiles, launches, selectedProfiles } = profileStage
  const managers = createWorkflowManagerResolver({ pool: database.pool, harnessMode: harnessHost.mode,
    claudeClient: infrastructure?.claudeClient, fileStorageRoot, processRegistry, workflowAccountBindings, remoteWorkflow,
    localWorkflowArtifacts: () => {
      if (!started.localWorkflowArtifacts) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
        'Local workflow artifact storage is unavailable.', 503)
      return started.localWorkflowArtifacts
    },
    nativeFactories, harnessRegistry, providerAccounts, claudeProfiles, selectedProfiles, runs, launches })
  const validateContinuation = placedContinuationValidator(database.pool, locations, remoteWorkflow,
    createAcceptedDestinationContinuation({ pool: database.pool, locations, devices: deviceRuntime,
      placement: () => started.agentPlacement }))
  const credentials = new WorkerCredentialService(database.pool, access)
  const prepareWorkflowManagerContext = createWorkflowManagerContextPreparer({ pool: database.pool, remoteWorkflow, providerAccounts,
    workflowAccountBindings })
  return { managers, validateContinuation, credentials, prepareWorkflowManagerContext }
}

function createExecutionCoordinator({ base, runtimeState, transport, accountStage, repositoryStage, qualificationStage, profileStage, managerStage }: {
  base: ProductionBase
  runtimeState: ProductionState
  transport: MainTransport
  accountStage: AccountStage
  repositoryStage: RepositoryStage
  qualificationStage: QualificationStage
  profileStage: ProfileStage
  managerStage: ManagerStage
}) {
  const { config, database } = base
  const { access, processRegistry } = transport
  const { reviewCapture, workflowCapture } = accountStage
  const { budgets, locations, remoteWorkflow, repository, runs, workflowCollaboration } = repositoryStage
  const { appMcpEndpoint, nativeFactories } = qualificationStage
  const { appRoutes, launches } = profileStage
  const { credentials, managers, prepareWorkflowManagerContext, validateContinuation } = managerStage
  const launchCredentials = createExecutionCredentialProvider({ pool: database.pool, access, credentials, appRoutes,
    isClosing: () => runtimeState.closing, validateContinuation, runs, remoteWorkflow, locations, managers, nativeFactories,
    appMcpEndpoint, prepareWorkflowManagerContext, launches })
  const approvals = new ApprovalExecutionCoordinator({
    runs, interactions: repository, budgets, managers, activeTimeoutMs: config.harnesses.timeoutMs, credentials: launchCredentials, validateContinuation,
    workflowClosures: new PostgresWorkflowClosureStore(database.pool, executionId =>
      processRegistry instanceof NativeProcessRegistry
        && hasNativeRestartDetachment(processRegistry.scope(`execution:${executionId}`))),
    repeatReviewerBindings: new PostgresRepeatReviewerBindings(database.pool),
    nativeCaptures: { capture(input) {
      const evidence = workflowCapture.capture.capture(input)
      remoteWorkflow.capture(input, workflowCapture.verify.read(evidence))
      return evidence
    } }, reviewNativeCaptures: { capture(input) {
      const evidence = reviewCapture.capture.capture(input)
      remoteWorkflow.captureReview(reviewCapture.verify.read(evidence))
      return evidence
    } },
    recoverNativeProcesses: async (executionId, signal, owner) => {
      signal.throwIfAborted()
      const placement = await readExecutionPlacement(database.pool, executionId)
      const closed = placement?.hostRef.kind === 'device'
        ? await remoteWorkflow.confirmClosedExecution(executionId, signal, owner)
          || await remoteWorkflowPreparationClosed(database.pool, executionId)
        : await processRegistry.closeOwner(`execution:${executionId}`, signal)
      signal.throwIfAborted()
      return closed
    },
    reserveNativeLaunch: async (executionId, manager, consultation) => {
      if (remoteWorkflow.isRemote(executionId)) return
      const scope = launches.scopeOf(manager)
      const expectedOwner = consultation ? `consultation:${consultation.consultationId}` : `execution:${executionId}`
      if (!scope || scope.owner !== expectedOwner || scope.launchId) throw new DomainError(
        'NATIVE_LAUNCH_RESERVATION_CONFLICT', 'The exact manager launch scope is unavailable or already reserved.', 409)
      if (hasDetachedStdioProcess(scope)) return
      Object.assign(scope, await processRegistry.reserveLaunch(scope.owner))
    },
    prepareManagerContext: prepareWorkflowManagerContext,
    commitReviewNative: executionId => remoteWorkflow.afterReviewCommit(executionId),
    collaboration: workflowCollaboration } satisfies CurrentApprovalExecutionDependencies)
  const telemetryLifetime = new AbortController()
  return { launchCredentials, approvals, telemetryLifetime }
}

function createConversationManagers({ base, callbacks, started, transport, deviceRuntime, accountStage, repositoryStage, qualificationStage, profileStage, executionStage }: {
  base: ProductionBase
  callbacks: ProductionCallbacks
  started: StartedServices
  transport: MainTransport
  deviceRuntime: ProductionDeviceRuntime
  accountStage: AccountStage
  repositoryStage: RepositoryStage
  qualificationStage: QualificationStage
  profileStage: ProfileStage
  executionStage: ExecutionStage
}) {
  const { checkpoints, config, database, infrastructure } = base
  const { access, fileStorageRoot, harnessHost, processRegistry, responseJournal } = transport
  const { accountConfigurations, providerAccounts } = accountStage
  const { budgets, harnessRegistry, locations, qualificationRepository, repository, runs, selectedSuites, workflows } = repositoryStage
  const { nativeFactories } = qualificationStage
  const { claudeProfiles, launches, nativeConfigurations, selectedProfiles } = profileStage
  const { approvals, launchCredentials } = executionStage
  const engine = new LangGraphWorkflowEngine(
    runs, workflows, approvals, checkpoints.saver, config.harnesses.workspaceRoot,
    locations, launchCredentials, repository, async runId => {
      await started.hostCi?.cancelStoppedRun(runId)
    }, {}, (owner, version) => {
      if (!started.jobRuntime) throw new DomainError('WORKFLOW_JOB_COMPOSITION_REQUIRED', 'The actual Job domain has not initialized.', 503)
      const bound = started.jobRuntime.workflow.forOwner(owner, version)
      return { store: new PostgresWorkflowJobNodeStore(owner, version, runs.repeatRepositoryFactory().hostForOwner(owner, version),
        bound.locked, workflowJobStorePublication()), driver: bound.driver }
    },
  )
  const interactions = new InteractionService(
    repository, budgets, approvals, (interaction) => engine.resumeInteraction(interaction), responseJournal,
    (interaction) => approvals.inspectInteractionActivity(interaction), {
      start: (principal, source, input, options) => callbacks.operatorServices.get().runs.start(principal, source, input, options),
      wake: () => engine.reconcile(),
    },
    approvalCheckpointConsumers(engine),
  )
  const operatorWorkingDirectory = resolve(config.harnesses.workspaceRoot, 'operator')
  const operatorManagers = new Map<string, NativeHarnessSessionManager>()
  const operatorConversations = new PostgresOperatorConversationRepository(database.pool, accountConfigurations)
  const agentConversations = new PostgresAgentChatRepository(database.pool, providerAccounts.acceptedBindings)
  const workerChats = createProductionWorkerConversations({ pool: database.pool,
    endpoint: () => deviceRuntime.endpointForDomains(), profiles: selectedProfiles, claudeProfiles,
    operators: operatorConversations, agents: agentConversations, registry: harnessRegistry,
    qualifications: qualificationRepository, access, mcpForward: () => selectedMainMcpForward(callbacks.app.get()),
    agentMcp: { authorize: async request => {
      const principal = await access.authenticate(request.token, 'worker')
      const credential = await readConversationCredential(database.pool, principal.id)
      if (!credential) throw new DomainError('ACCESS_DENIED', 'A scoped Agent conversation credential is required.', 403)
      return { subject: credential.subject, expiresAt: principal.expiresAt }
    }, forward: () => selectedMainMcpForward(callbacks.app.get()) },
    fileService: () => productionFileTools(callbacks.app.get()),
    files: (conversationId, configuration, workingDirectory) => async ({ host, assertHost, ...turn }) => {
      const admissions = 'operatorId' in configuration
        ? operatorCodexFileAdmissions(() => callbacks.app.get(), database.pool, configuration, workingDirectory, fileStorageRoot,
          { host, assertCurrent: assertHost })
        : postgresCodexChatFiles(database.pool, () => {
          if (!started.fileStorage) throw new Error('Production file storage is not registered.')
          return started.fileStorage
        }, async () => host, { assertCurrent: assertHost })
      return productionCodexChatFiles(() => callbacks.app.get(), conversationId, admissions).prepare(turn)
    },
    suiteRevisions: selectedSuites ? {
      codex: selectedSuites.codex.revision,
    } : {} })
  const agentChatProfileSelection = createAgentChatProfileSelection({ pool: database.pool, runs })
  const recoverChatCompaction = createChatCompactionRecovery({ workerChats, selectedProfiles, harnessRegistry, processRegistry,
    nativeFactories, operatorConversations, agentConversations })
  const operatorAccountBindings = new Map<string, AcceptedProviderAccountBinding>()
  const resolveOperatorManager = createOperatorManagerResolver({
    app: () => callbacks.app.get(), pool: database.pool, config, workingDirectory: operatorWorkingDirectory,
    fileStorageRoot, harnessMode: harnessHost.mode, infrastructure, processRegistry, responseJournal,
    managers: operatorManagers, nativeFactories, harnessRegistry, providerAccounts, claudeProfiles, selectedProfiles,
    workerChats, operatorConversations, operatorAccountBindings, launches,
    chat: {
      prepareInput: prepareOperatorChatInput(database.pool, createWorkerChatPreflight(deviceRuntime)),
      prepareAccountBinding: async (configuration, conversationId) => {
        const binding = await providerAccounts.runtimeBinding('operator-command', `${conversationId}:session`,
          configuration.harness, configuration.harnessProfileSelection)
        if (binding) operatorAccountBindings.set(conversationId, binding)
        else operatorAccountBindings.delete(conversationId)
      },
      modelOptions: configuration => chatModelOptions(configuration, harness => nativeConfigurations.options(harness)),
      qualifiedSteer: qualifiedAgentChatSteer,
      recoverCompaction: recoverChatCompaction,
    },
  })
  return { engine, interactions, operatorWorkingDirectory, operatorManagers, operatorConversations, agentConversations, workerChats, agentChatProfileSelection, recoverChatCompaction, operatorAccountBindings, resolveOperatorManager }
}

function createOperatorChat({ base, transport, deviceRuntime, accountStage, repositoryStage, qualificationStage, profileStage, conversationStage }: {
  base: ProductionBase
  transport: MainTransport
  deviceRuntime: ProductionDeviceRuntime
  accountStage: AccountStage
  repositoryStage: RepositoryStage
  qualificationStage: QualificationStage
  profileStage: ProfileStage
  conversationStage: ConversationStage
}) {
  const { database, infrastructure } = base
  const { access, processRegistry } = transport
  const { providerAccounts } = accountStage
  const { harnessRegistry, operators, rollout } = repositoryStage
  const { appMcpEndpoint, nativeFactories } = qualificationStage
  const { claudeProfiles, harnessInstances, launches } = profileStage
  const { operatorConversations, operatorWorkingDirectory, resolveOperatorManager, workerChats } = conversationStage
  const chatAuthority = new PostgresOperatorChatAuthority(
    database.pool, access, rollout, operatorWorkingDirectory, appMcpEndpoint,
    (manager) => workerChats.inspector(manager) ?? nativeFactories.inspector(manager),
    async (manager, configuration, environment, signal) => {
      const claude = launches.claudeOf(manager)
      const servers: ClaudeHarnessConfiguration['mcpServers'] = configuration.harness.harness === 'claude'
        ? configuration.harness.mcpServers : {}
      const serverName = appMcpServerName(servers)
      const configured = servers[serverName]
      const token = readProductEnvironment(environment.variables, 'MCP_TOKEN')
      const worker = workerChats.deliverClaudeCredential(manager)
      if ((!claude && !worker) || !configured || configured.type !== 'http' || configured.url !== appMcpEndpoint || !token) throw new DomainError('OPERATOR_MCP_SETUP_REQUIRED', 'The accepted Claude HTTP credential arrangement is unavailable.', 409)
      if (worker) await worker(token, signal)
      else if (claude) await claude.manager.refreshInspectionCredentials({ ...await claude.inspectionStart(), environment }, {
          ...(configuration.harness.harness === 'claude' ? configuration.harness.mcpServers : {}),
          [serverName]: { ...configured, headers: { Authorization: `Bearer ${token}` } },
        }, signal)
      const context = manager.mcpInspectionContext ? await manager.mcpInspectionContext(signal)
        : { runnerId: 'runner-local', workingDirectory: operatorWorkingDirectory }
      const checked = await new McpDetectionService(workerChats.inspector(manager) ?? nativeFactories.inspector(manager), appMcpEndpoint).preflight({
        harness: 'claude', ...context, signal,
      })
      if (checked.detection.state !== 'connected' || checked.detection.credentialArrangement?.kind !== 'scoped_http_header') throw new DomainError('OPERATOR_MCP_SETUP_REQUIRED', 'Claude did not acknowledge the scoped Operator credential on its current query.', 409)
    },
    async (principal, configuration, signal) => {
      if (configuration.harness.harness !== 'claude' || !configuration.harnessProfileSelection) throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'Claude setup requires its exact saved host profile.', 409)
      const owner: ClaudeProfileOwner = { kind: 'operator-inspection', principalId: principal.id,
        configurationVersionId: configuration.id, configurationHash: configuration.contentHash, admissionSignal: signal }
      const accepted = await claudeProfiles.admit(owner, configuration.harnessProfileSelection)
      if (accepted.override.target.hostRef.kind === 'device') {
        return inspectWorkerClaudeOperatorConfiguration({ accepted, endpoint: deviceRuntime.endpointForDomains(),
          expectedEndpoint: appMcpEndpoint, signal,
          revalidate: async () => { await claudeProfiles.revalidate(owner, accepted) } })
      }
      const apiKey = await requireClaudeProductionCredentialDelivery(configuration.harness, providerAccounts,
        accepted.override.target.hostRef)
      const binding = harnessRegistry.pinOverride(accepted.override), binary = binding.installation.launcher.resolvedLauncher
      if (!binary) throw new DomainError('HARNESS_HOST_MISMATCH', 'Claude setup must inspect its actual local installed profile.', 409)
      const recovery = await processRegistry.reserveLaunch(`operator-configuration-inspection:${randomUUID()}`)
      const close = async () => {
        await processRegistry.abandonReservedLaunch(recovery)
        if (!await processRegistry.closeOwner(recovery.owner)) throw new Error('Claude read-only configuration inspection closure is unconfirmed.')
      }
      try { return await inspectClaudeOperatorConfiguration({ accepted, binary, workingDirectory: operatorWorkingDirectory,
        ...(apiKey ? { apiKey } : {}),
        endpoint: appMcpEndpoint, recovery, signal, ...(infrastructure?.claudeClient ? {
          loadClient: (profilePath, processRecovery, selectedBinary) => infrastructure.claudeClient!({ profilePath, recovery: processRecovery, binary: selectedBinary }),
        } : {}),
        revalidate: async () => { await claudeProfiles.revalidate(owner, accepted); await nativeFactories.assertInstallationUnchanged(binding, signal) } }) }
      finally { await close() }
    },
  )
  const chat = new OperatorChatService(
    operatorConversations, operators,
    resolveOperatorManager, operatorWorkingDirectory, chatAuthority,
    async (principal, configuration, commandId) => {
      const selection = await withTransaction(database.pool,
        client => harnessInstances.selectionForConfiguration(principal, configuration, client))
      return selection ?? harnessInstances.prepareOperatorConfiguration(principal, 'http', configuration, commandId)
    },
  )
  return { chatAuthority, chat }
}

function createAgentChat({ base, callbacks, transport, accountStage, repositoryStage, qualificationStage, profileStage, executionStage, conversationStage }: {
  base: ProductionBase
  callbacks: ProductionCallbacks
  transport: MainTransport
  accountStage: AccountStage
  repositoryStage: RepositoryStage
  qualificationStage: QualificationStage
  profileStage: ProfileStage
  executionStage: ExecutionStage
  conversationStage: ConversationStage
}) {
  const { config, database, infrastructure } = base
  const { chatFileAdmissions, harnessHost, processRegistry } = transport
  const { accountConfigurations, providerAccounts } = accountStage
  const { harnessRegistry, locations, rollout, runs, workflows } = repositoryStage
  const { hostSettings, nativeFactories } = qualificationStage
  const { claudeProfiles, hostProfileChecks, nativeConfigurations, selectedProfiles } = profileStage
  const { approvals } = executionStage
  const { agentChatProfileSelection, agentConversations, engine, recoverChatCompaction, workerChats } = conversationStage
  const agentChatManagers = new Map<string, NativeHarnessSessionManager>()
  const conversationNativeAccess = new ConversationNativeAccess(new ConversationCredentials(database.pool))
  const resolveAgentChatManager = createAgentChatManagerResolver({
    app: () => callbacks.app.get(), pool: database.pool, harnessMode: harnessHost.mode, infrastructure,
    processRegistry, nativeFactories, harnessRegistry, providerAccounts, claudeProfiles, selectedProfiles,
    workerChats, managers: agentChatManagers, agentConversations, agentChatProfileSelection,
    conversationNativeAccess, chatFileAdmissions,
  })
  const agentChatManagerFactory = withAgentChatHooks(resolveAgentChatManager, {
    recoverCompaction: createAgentChatCompactionRecovery({ agentConversations, profileSelection: agentChatProfileSelection,
      recover: recoverChatCompaction }),
    unavailable: createAgentChatAvailability({ profileSelection: agentChatProfileSelection, hostSettings, hostProfileChecks,
      harnessRegistry }),
    prepareInput: prepareAgentChatInput(database.pool),
    qualifiedSteer: qualifiedAgentChatSteer,
    modelOptions: configuration => chatModelOptions(configuration, harness => nativeConfigurations.options(harness)),
    release: (conversationId) => { agentChatManagers.delete(conversationId) },
    closeRetainedSession: (conversationId, configuration, principalId, signal) =>
      workerChats.closeRetainedSession(conversationId, configuration, principalId, signal),
    closeRecoveredSession: (id, signal) => workerChats.closeConversation(id, signal),
  })
  const agentChat = new AgentChatService(database.pool, agentConversations,
    new PostgresOperatorConversationRepository(database.pool, accountConfigurations), workflows, runs, agentChatManagerFactory, config.harnesses.workspaceRoot)
  const reviews = new AutomaticReviewService(database.pool, runs, approvals, locations, rollout,
    async (runId) => {
      // AutomaticReviewService committed the exact review cause and durable Stop
      // intent first. A process restart or failed closure cannot lose that cause.
      // The one engine owns negative settlement and cleanup. No extra terminal
      // writer follows a successful cancel, and uncertainty remains retryable.
      await engine.cancel(runId)
    })
  return { conversationNativeAccess, agentChat, reviews }
}

function createOperatorServices({ base, callbacks, started, runtimeState, transport, deviceRuntime, browserStage, accountStage, repositoryStage, qualificationStage, profileStage, managerStage, executionStage, conversationStage, operatorChatStage, agentChatStage }: {
  base: ProductionBase
  callbacks: ProductionCallbacks
  started: StartedServices
  runtimeState: ProductionState
  transport: MainTransport
  deviceRuntime: ProductionDeviceRuntime
  browserStage: BrowserStage
  accountStage: AccountStage
  repositoryStage: RepositoryStage
  qualificationStage: QualificationStage
  profileStage: ProfileStage
  managerStage: ManagerStage
  executionStage: ExecutionStage
  conversationStage: ConversationStage
  operatorChatStage: OperatorChatStage
  agentChatStage: AgentChatStage
}) {
  const { checkpoints, config, createCurrentProduction, database } = base
  const { access, workerExecution } = transport
  const { browser } = browserStage
  const { accountConfigurations, bugReports, commands, memoryBoards, providerAccounts } = accountStage
  const { foundationSettings, harnessRegistry, locations, operators, projectRoot, remoteExecution, rollout, runs, selectedSuites, workflows } = repositoryStage
  const { harnessCompatibility, harnessQualifications, hostSettings } = qualificationStage
  const { claudeProfiles, harnessCatalog, harnessInstances, selectedProfiles } = profileStage
  const { managers } = managerStage
  const { approvals } = executionStage
  const { engine, interactions, operatorConversations } = conversationStage
  const { chat } = operatorChatStage
  const { agentChat, conversationNativeAccess } = agentChatStage
  const nativeFactory = createCurrentNativeProductionFactory({
    isRuntimeOpen: () => runtimeState.initialized && !runtimeState.closing,
    reportDispatchFailure: (runId, code, error) => callbacks.app.get().log.error({ runId, code, err: error }, 'current workflow dispatch remains unresolved'),
  })
  const productionContext = { primaryPool: database.pool, commands,
    runs, workflows, locations, engine, nativeExecutions: approvals, interactions, checkpointer: checkpoints.saver }
  const binding = (createCurrentProduction ?? nativeFactory)(productionContext)
  if (!isCurrentNativeProductionBinding(binding, productionContext)) throw new DomainError(
    'CURRENT_PRODUCTION_BINDING_REQUIRED', 'Production requires the concrete constructor-bound native lifecycle, not a shape-only publisher.', 503)
  const assertRuntimeOpen = () => {
    if (!runtimeState.initialized || runtimeState.closing) throw new DomainError('CURRENT_RUNTIME_UNAVAILABLE',
      'The native runtime has not acquired ownership or is shutting down.', 503)
  }
  const currentProduction: CurrentRunProductionBinding = Object.freeze({
    startPublication: { ...binding.startPublication, workerExecution, accountBindings: providerAccounts.acceptedBindings,
      ...(selectedSuites ? { placementAdmission: {
      prepare: (...args: Parameters<AgentPlacementProducer['prepare']>) => {
        if (!started.agentPlacement) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual saved-placement admission producer is unavailable.', 503)
        return started.agentPlacement.prepare(...args)
      },
    } } : {}) },
    availability: () => runtimeState.initialized && !runtimeState.closing ? binding.availability() : { runtimeAdmission: false, stopAvailable: false },
    assertStartReady: () => { assertRuntimeOpen(); binding.assertStartReady() },
    assertStopReady: () => { assertRuntimeOpen(); binding.assertStopReady() },
    stop: (context: CurrentStopContext) => { assertRuntimeOpen(); return binding.stop(context) },
    reportDispatchFailure: (runId: string, error: unknown) => binding.reportDispatchFailure(runId, error),
  })
  const operatorServices: OperatorServices & { fileRetention: FileRetentionService } = {
    bugReports,
    providerAccounts,
    devices: deviceRuntime.management,
    harnessInstances, harnessRegistry,
    fileRetention: new FileRetentionService(database.pool, commands),
    executionReadiness: new ExecutionReadinessService(rollout, harnessCatalog, async (principal, configurationVersionId) => {
      if (configurationVersionId) await authorizeOperatorConfigurationRead(database.pool,
        await access.currentHarnessInspectionPrincipal(principal.id), configurationVersionId)
      const defaults = configurationVersionId ? undefined : await foundationSettings.getAgentDefaults()
      const configuration = configurationVersionId ? await operatorConversations.configuration(configurationVersionId)
        : await operators.inspectionConfiguration(defaults!.revision)
      if (!configuration || configuration.operatorId !== 'application-operator') throw new DomainError('OPERATOR_CONFIGURATION_NOT_FOUND', 'The saved Operator configuration is unavailable.', 409)
      try {
        if (configuration.harnessProfileSelection) {
          const owner: ClaudeProfileOwner = { kind: 'operator-inspection', principalId: principal.id,
            configurationVersionId: configuration.id, configurationHash: configuration.contentHash }
          if (configuration.harness.harness === 'claude') {
            const accepted = await claudeProfiles.admit(owner, configuration.harnessProfileSelection)
            requireClaudePolicyQualification(configuration.harness, accepted)
          } else await selectedProfiles.admit(owner, configuration.harnessProfileSelection)
        } else {
          if (configuration.harness.harness === 'claude') throw new DomainError('HARNESS_PROFILE_REQUIRED', 'The saved Operator Claude configuration has no exact qualified host profile.', 409)
          await harnessCatalog.checkConfiguration(principal, configuration.harness)
        }
      } catch (error) { throw qualificationError(error) }
      return { configurationVersionId: configuration.id, harness: configuration.harness, defaultsRevision: defaults?.revision ?? null }
    }),
    operatorChat: chat,
    agentChat,
    memoryBoards,
    workspaces: new WorkspaceManagementService(database.pool, commands, locations, foundationSettings, projectRoot),
    locations,
    workflows: new WorkflowManagementService(database.pool, commands, {
      agentActiveTimeoutMs: config.harnesses.timeoutMs,
      accountConfigurations,
      worktrees: {
        readyRoot: (principal, workspaceId, sql) => {
          const { workspaceRepositories } = callbacks.runtimeServices.get()
          if (!workspaceRepositories) return Promise.resolve(undefined)
          return workspaceRepositories.readyRoot(principal, workspaceId, sql)
        },
        sources: {
          resolveRootBinding: (...args) => {
            if (!started.jobRuntime) throw new DomainError('SOURCE_UNAVAILABLE', 'Source services are not initialized.', 503)
            return started.jobRuntime.sources.resolveRootBinding(...args)
          },
          resolveApprovedSource: (...args) => {
            if (!started.jobRuntime) throw new DomainError('SOURCE_UNAVAILABLE', 'Source services are not initialized.', 503)
            return started.jobRuntime.sources.resolveApprovedSource(...args)
          },
        },
        roots: {
          resolve: (...args) => {
            if (!started.jobRuntime) throw new DomainError('SOURCE_UNAVAILABLE', 'Root services are not initialized.', 503)
            return started.jobRuntime.policies.resolve(...args)
          },
        },
      },
    }),
    agents: new AgentManagementService(database.pool),
    harnesses: harnessCatalog,
    harnessCompatibility,
    ...(harnessQualifications ? { harnessQualifications } : {}),
    remoteExecution,
    settings: new FoundationSettingsManagementService(foundationSettings, commands, harnessCatalog, operators, harnessInstances, accountConfigurations),
    workerExecution,
    runs: new RunManagementService(database.pool, commands, runs, engine, locations, currentProduction, async (executionId, session, cursor, signal) => {
      const owned = managers.residentForRead(executionId)
      if (!owned?.manager.subagentHistory || owned.context.harness !== session.harness) throw new DomainError('SUBAGENT_HISTORY_UNAVAILABLE', 'The original admitted parent history owner is unavailable.', 409)
      owned.assertCurrent()
      const page = await owned.manager.subagentHistory(session, cursor, signal)
      owned.assertCurrent()
      return page
    }, productionSubagentControls(managers)),
    commands,
    interactions: new OperatorInteractionService(interactions),
    // Reads and lifecycle mutations share the same canonical V3 journal.
    runGraph: new RunGraphReadService(database.pool, { qualifiedReads: true }),
    runPlacements: new RunPlacementReadService(database.pool, readRemoteObservations),
    placementChoices: new NodePlacementChoicesService(database.pool, new ProductionPlacementChoiceDiscovery(
      database.pool, () => {
        if (!started.jobRuntime) throw new DomainError('PLACEMENT_CHOICES_UNAVAILABLE', 'Computer choices are not initialized.', 503)
        const runtime = started.jobRuntime
        return { roots: runtime.policies, sources: runtime.sources, profiles: hostSettings, registry: harnessRegistry,
          harnessInstances,
          ensureProfileReady: profile => harnessInstances.ensureReady(profile),
          ensureComputerReady: async host => {
            workerExecution.requireEnabled(host)
            if (host.kind === 'device') await deviceRuntime.endpointForDomains().assertWorkerBundleReady(host.deviceId)
          },
          computerOnline: host => host.kind === 'main' || deviceRuntime.presenceFor(host.deviceId)?.phase === 'ready',
          provisionRoot: (...args: Parameters<ProductionCiEnrollmentInventory['root']>) => {
            const workspaceRoots = callbacks.runtimeServices.get().workspaceRoots
            if (!workspaceRoots) throw new DomainError('PLACEMENT_CHOICES_UNAVAILABLE', 'Workspace roots are not initialized.', 503)
            const inventory = new ProductionCiEnrollmentInventory(database.pool, runtime.sources,
              () => deviceRuntime.endpointForDomains(), () => runtime.mainCiRuntime, workerExecution,
              new ManagedWorkspaceRootService(commands, workspaceRoots, runtime.policies))
            return inventory.root(...args)
          },
        }
      },
    )),
  }
  operatorServices.workflowHierarchy = new WorkflowHierarchyService(database.pool, commands,
    operatorServices.workflows)
  const executionChat = createWorkflowExecutionChatService(database.pool, approvals)
  operatorServices.executionChat = executionChat
  const chatDelivery = createProductionChatDelivery({ pool: database.pool,
    agent: agentChat, operator: chat,
    execution: executionChat,
    bindConversationScope: conversationNativeAccess.rebind,
  })
  operatorServices.browser = browser
  operatorServices.chatDelivery = chatDelivery.router
  return { operatorServices, chatDelivery }
}

function createHttpApplication({ base, started, transport, accountStage, repositoryStage, qualificationStage, profileStage, conversationStage, operatorChatStage, operatorStage }: {
  base: ProductionBase
  started: StartedServices
  transport: MainTransport
  accountStage: AccountStage
  repositoryStage: RepositoryStage
  qualificationStage: QualificationStage
  profileStage: ProfileStage
  conversationStage: ConversationStage
  operatorChatStage: OperatorChatStage
  operatorStage: OperatorStage
}) {
  const { checkpoints, config, database, infrastructure, logger } = base
  const { access } = transport
  const { accountConfigurations, bugReports, commands, providerAccounts } = accountStage
  const { locations, projectRoot, repository, runs, workflows, workspaces } = repositoryStage
  const { appMcpEndpoint, nativeFactories } = qualificationStage
  const { harnessCatalog, harnessInstances, harnessSettings, nativeConfigurations } = profileStage
  const { engine, interactions } = conversationStage
  const { chat } = operatorChatStage
  const { operatorServices } = operatorStage
  const detection = new McpDetectionService({
    async inspect(input) {
      if (input.runnerId !== 'runner-local') {
        throw new DomainError('RUNNER_UNSUPPORTED', 'This API can inspect only its local runner.', 409)
      }
      // Diagnostics allocate their own credential-free child, never a workflow manager.
      if (input.harness === 'claude') throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'Claude diagnostics require an explicit accepted profile owner.', 409)
      const { manager, inspector } = nativeFactories.allocate({
        harness: input.harness, role: 'diagnostics', workingDirectory: input.workingDirectory,
        ownerAgentId: 'mcp-inspection', appMcpAccess: 'none',
      })
      try { return await inspector.inspect(input) } finally { await nativeFactories.disposeAuxiliary(manager) }
    },
  }, appMcpEndpoint)
  const operatorExtensions = createOperatorExtensions({
    pool: database.pool, commands, catalog: harnessCatalog, native: nativeConfigurations,
    detection, locations, workflows: operatorServices.workflows.current,
    provisioningRoot: projectRoot, harnessProfiles: harnessInstances,
    accountConfigurations,
    rebindRestoredFolder: (principal, selection) => {
      const roots = runtimeServices.workspaceRoots
      if (!roots) throw new DomainError('WORKSPACE_ROOTS_UNAVAILABLE', 'Workspace folder binding is unavailable.', 503)
      return roots.set(principal, 'mcp', selection)
    },
  })
  const runtimeServices: OperatorServices = { ...operatorServices, extensions: operatorExtensions, harnessSettings }
  const localHuman = new PostgresLocalHumanAccess(database.pool, access)
  const runtimeBuildIdentity = readRuntimeBuildIdentity()
  const routes = {
    runtimeBuildIdentity: () => runtimeBuildIdentity,
    runtimeIdentity: async () => {
      const identity = await readRuntimeIdentity(database.pool,
        fileURLToPath(new URL('../../../', import.meta.url)), config.database.connectionString)
      const testResourcesId = readTestResourcesIdentity(config)
      return { ...identity, ...(testResourcesId ? { testResourcesId } : {}) }
    },
    localHuman,
    ...(config.browserOrigin ? { browserOrigin: config.browserOrigin } : {}),
    readiness: { database, checkpoints },
    readinessTimeoutMs: config.readinessTimeoutMs,
    product: { workspaces, workflows, runs, engine, interactions, chat },
    operator: { access, services: runtimeServices },
    appMcp: { access, commands, bugReports, interactions: Object.assign(new PostgresAppInteractionService(database.pool, repository, commands, interactions), {
      syncedFolder: (workspaceId: string, hostRef: { kind: 'main' } | { kind: 'device'; deviceId: string }) =>
        runtimeServices.computerSync?.sharedFolder(workspaceId, hostRef) ?? Promise.resolve(null) }) },
    workerArtifacts: () => started.workflowArtifacts?.extension,
    mcpDetection: { pool: database.pool, service: detection },
    production: { fileRetention: operatorServices.fileRetention },
  } satisfies ApiRouteServices
  const app = buildApp({ ...routes, logger,
    ...(infrastructure?.closeInfrastructure ? { closeInfrastructure: infrastructure.closeInfrastructure } : {}) })
  app.addHook('onClose', () => providerAccounts.close())
  return { runtimeServices, routes, app }
}

/** Every route group the production runtime has published so far. */
function productionRoutes(httpStage: HttpStage, started: StartedServices): ApiRouteServices {
  const { routes, runtimeServices } = httpStage
  return { ...routes, production: { ...routes.production,
    ...(started.files ? { files: started.files } : {}),
    ...(started.workflowArtifacts ? { workflowArtifacts: started.workflowArtifacts } : {}),
    ...(started.trustedConnections ? { trustedConnections: started.trustedConnections } : {}),
    ...(runtimeServices.resourceTelemetry ? { resourceTelemetry: runtimeServices.resourceTelemetry } : {}),
    ...(runtimeServices.jobRuntimeProfiles ? { jobRuntimeProfiles: { profiles: runtimeServices.jobRuntimeProfiles,
      ...(runtimeServices.ciRuntime ? { ciRuntime: runtimeServices.ciRuntime } : {}) } } : {}) } }
}

function createRuntimeControl({ base, callbacks, started, runtimeState, transport, deviceRuntime, browserStage, accountStage, repositoryStage, qualificationStage, profileStage, managerStage, executionStage, conversationStage, operatorChatStage, agentChatStage, httpStage }: {
  base: ProductionBase
  callbacks: ProductionCallbacks
  started: StartedServices
  runtimeState: ProductionState
  transport: MainTransport
  deviceRuntime: ProductionDeviceRuntime
  browserStage: BrowserStage
  accountStage: AccountStage
  repositoryStage: RepositoryStage
  qualificationStage: QualificationStage
  profileStage: ProfileStage
  managerStage: ManagerStage
  executionStage: ExecutionStage
  conversationStage: ConversationStage
  operatorChatStage: OperatorChatStage
  agentChatStage: AgentChatStage
  httpStage: HttpStage
}) {
  const { config, database } = base
  const { access, entrypoint, fileStorageRoot, rsync } = transport
  const { browser } = browserStage
  const { commands } = accountStage
  const { harnessRegistry } = repositoryStage
  const { harnessCompatibility, harnessQualifications, nativeFactories } = qualificationStage
  const { appRoutes, harnessCatalog, harnessInstances, harnessSettings, installationMonitor, nativeConfigurations } = profileStage
  const { managers } = managerStage
  const { approvals, telemetryLifetime } = executionStage
  const { engine, operatorManagers, workerChats } = conversationStage
  const { chat } = operatorChatStage
  const { agentChat, reviews } = agentChatStage
  const { app, runtimeServices } = httpStage
  const mountArtifacts = () => {
    if (started.workflowArtifacts || !started.fileStorage || !started.artifactComposition) return
    started.workflowPhysicalArtifacts = new PostgresWorkflowPhysicalArtifacts(started.artifactComposition.mainId,
      { authority: started.artifactComposition.authority, files: started.fileStorage.repository })
    started.workflowArtifacts = createProductionWorkflowArtifacts({ app, pool: database.pool, files: started.fileStorage,
      ...started.artifactComposition, attempts: started.artifactComposition.fence, commands, access,
      endpoint: deviceRuntime.endpointForDomains(), stagingRoot: resolve(fileStorageRoot, 'workflow-artifact-transfers') })
  }
  const startupLifetime = new AbortController()
  const runtimeOwner = new OperatorRuntimeOwner(config.database.connectionString, (error) => {
    app.log.error({ err: error }, 'native runtime ownership lost; stopping execution')
    beginShutdown()
    // Never re-enter/await app.close() from an onClose cleanup. The failed
    // connection has already lost its lock; native recovery fencing still applies.
    if (!runtimeState.httpClosing) void callbacks.shutdown.get()().catch((failure: unknown) => {
      app.log.error({ err: failure }, 'shutdown after native runtime ownership loss failed')
    })
  })
  const lifecycle = new RuntimeShutdown({
    stop: [
      { name: 'shared file sync admission', run: () => {
        runtimeState.stopSyncTimer()
        runtimeServices.computerSync?.stopAdmission()
      } },
      { name: 'computer maintenance admission', run: () => {
        runtimeState.stopComputerTimers()
        browser.stopAdmission()
        runtimeServices.computerMaintenance?.stopAdmission()
      } },
      { name: 'passive resource telemetry admission', run: async () => { telemetryLifetime.abort() } },
      { name: 'device admission', run: () => deviceRuntime.stopAdmission() },
      { name: 'original rsync byte ownership', run: () => rsync.kind === 'configured' ? rsync.rsyncWriters.close() : undefined },
      { name: 'canonical harness inventory and profile checks', run: async () => {
        const inventoryClose = installationMonitor.close()
        harnessRegistry.stop()
        await Promise.all([inventoryClose, harnessInstances.closeChecks()])
      } },
      { name: 'diagnostic and configuration qualification admission', run: async () => { nativeFactories.stopAuxiliaries() } },
      { name: 'live harness qualification admission', run: async () => { harnessQualifications?.stop() } },
      { name: 'harness compatibility diagnostics', run: () => harnessCompatibility.close() },
      { name: 'native MCP settings', run: () => harnessSettings.mcp.shutdown() },
      { name: 'Codex plugin settings', run: () => harnessSettings.plugins.shutdown() },
      { name: 'harness qualification checks', run: () => Promise.all([harnessCatalog.shutdownChecks(), nativeConfigurations.shutdownChecks()]).then(() => undefined) },
      { name: 'browser runtime', run: async () => { await browser.stop(); callbacks.browserRemote.get().close() } },
      { name: 'chat delivery', run: async () => { runtimeState.stopChatDelivery?.() } },
      { name: 'Operator chat', run: () => chat.shutdown() },
      { name: 'Agent chat', run: () => agentChat.shutdown() },
      { name: 'automatic reviews', run: () => reviews.shutdown() },
      { name: 'workflow engine', run: () => engine.shutdown() },
      { name: 'cloud CI starts', run: () => { for (const cloud of started.cloudCis ?? []) cloud.stop() } },
    ],
    drain: [
      { name: 'startup schema preparation', run: () => runtimeState.schemaPreparation?.then(() => undefined, () => undefined) },
      { name: 'shared file sync work', run: () => runtimeServices.computerSync?.join() },
      { name: 'live harness qualification', run: () => harnessQualifications?.join() },
      // Initialization errors belong to initialize()'s caller, not to cleanup.
      // Wait for its last DB/filesystem operation even if startup was canceled.
      { name: 'initialization', run: () => runtimeState.initialization?.then(() => undefined, () => undefined) },
      { name: 'native defaults initialization', run: () => runtimeState.nativeDefaultsInitialization?.then(() => undefined, () => undefined) },
      { name: 'reconciliation', run: () => runtimeState.reconciliation },
      { name: 'source reservation reclamation', run: () => started.jobRuntime?.drainMaterializationReservationReconciliation() },
    ],
    dispose: [
      { name: 'computer maintenance tasks', run: () => runtimeServices.computerMaintenance?.drain() },
      { name: 'worker conversation callback admissions', run: async () => { await workerChats?.close() } },
      { name: 'installed rsync canonical receiver', run: () => entrypoint ? entrypoint.close() : undefined },
      { name: 'workflow artifact byte receiver', run: async () => { await started.workflowArtifacts?.receiver.close() } },
      { name: 'passive resource telemetry collector', run: async () => { await started.telemetry?.close() } },
      { name: 'diagnostic and configuration qualification native managers', run: () => nativeFactories.disposeAuxiliaries() },
      { name: 'Job dispatch owners', run: async () => { await started.jobRuntime?.close() } },
      { name: 'execution native managers', run: async () => {
        // Preserve the manager and authenticated channels until every restart detach commits, including retries.
        try {
          await approvals.closeForRestart()
          await managers.dispose()
          await deviceRuntime.drain()
        } catch (error) {
          throw new AggregateError([error], 'Execution native manager disposal was incomplete.', { cause: error })
        }
      } },
      { name: 'remaining Operator native managers', run: async () => {
        // Snapshot only after all producers have drained. Keep failed disposals
        // visible instead of clearing their ownership records unconditionally.
        const results = await Promise.allSettled([...operatorManagers.entries()].map(async ([id, manager]) => {
          const disposable = manager as NativeHarnessSessionManager & { dispose?: () => Promise<void> }
          if (!disposable.dispose) throw new Error('An owned native manager has no disposal contract.')
          await disposable.dispose()
          if (operatorManagers.get(id) === manager) operatorManagers.delete(id)
        }))
        const errors = results.flatMap((result) => result.status === 'rejected' ? [result.reason] : [])
        if (errors.length) throw new AggregateError(errors, 'Operator native manager disposal was incomplete.')
      } },
    ],
    // Independent of initialized: startup can acquire ownership and then fail.
    releaseOwnership: async () => {
      await appRoutes.close()
      await runtimeOwner.close()
    },
  })
  const beginShutdown = (): void => {
    runtimeState.closing = true
    appRoutes.stopAdmission()
    startupLifetime.abort()
    lifecycle.begin()
  }
  const assertOpen = (): void => {
    if (runtimeState.closing) throw new DomainError('NATIVE_RUNTIME_CLOSING', 'The native runtime is shutting down.', 503)
  }
  const startupDatabase = <T>(work: () => Promise<T>): Promise<T> =>
    retryStartupDatabase(work, { signal: startupLifetime.signal, check: assertOpen })
  return { mountArtifacts, startupLifetime, runtimeOwner, lifecycle, beginShutdown, assertOpen, startupDatabase }
}

function createRuntimeStartup(services: ProductionServices) {
  const { base, started, runtimeState, transport, deviceRuntime, browserStage, repositoryStage, qualificationStage, profileStage, operatorStage, httpStage, controlStage } = services
  const { checkpoints, config, database } = base
  const { harnessHost } = transport
  const { browser } = browserStage
  const { foundationSettings, harnessRegistry, operators } = repositoryStage
  const { appMcpEndpoint } = qualificationStage
  const { nativeConfigurations } = profileStage
  const { chatDelivery } = operatorStage
  const { app } = httpStage
  const { assertOpen, runtimeOwner, startupDatabase, startupLifetime } = controlStage
  const synchronizeOperatorDefaults = async (
    template: RecordedAgentDefaults['operator'],
  ): Promise<void> => {
    await withTransaction(database.pool, async client => {
      const current = await operators.ensureWithClient(client)
      if (isDeepStrictEqual(current.configuration.harness, template.harness)
        && isDeepStrictEqual(current.configuration.nativeTools, template.nativeTools)) return
      await operators.updateWithClient(
        client, template.harness, current.operator.currentConfigurationVersionId,
        template.showThinking ?? false, template.assignedSkills, template.harnessProfileSelection ?? null,
        template.nativeTools ?? null,
      )
    })
  }
  const prepareSchema = (): Promise<void> => {
    if (runtimeState.closing) return Promise.reject(new DomainError('NATIVE_RUNTIME_CLOSING', 'The native runtime is shutting down.', 503))
    runtimeState.schemaPreparation ??= Promise.resolve().then(async () => {
      await runtimeOwner.acquire()
      assertOpen()
      await startupDatabase(() => database.migrate())
      assertOpen()
      await startupDatabase(() => checkpoints.setup())
      assertOpen()
    })
    return runtimeState.schemaPreparation
  }
  const initialize = (): Promise<void> => {
    if (runtimeState.closing) return Promise.reject(new DomainError('NATIVE_RUNTIME_CLOSING', 'The native runtime is shutting down.', 503))
    if (runtimeState.initialized) return Promise.resolve()
    // Coalesce startup and publish its lifetime before starting any async work.
    runtimeState.initialization ??= Promise.resolve().then(async () => {
      await initializeRuntimeOwner(services, synchronizeOperatorDefaults)
      const machine = await deviceRuntime.initializeFromRuntime(() => startupDatabase(() => readRuntimeIdentity(database.pool,
        fileURLToPath(new URL('../../../', import.meta.url)), config.database.connectionString)))
      started.machine = machine
      assertOpen()
      await browser.start(machine.installationId)
      const jobRuntime = await initializeJobServices(services, machine)
      await initializeWorkflowArtifacts(services, machine, jobRuntime)
      const computerServices = await initializeComputerServices(services, machine, jobRuntime)
      await initializeCiServices(services, machine, jobRuntime, computerServices)
      await initializeHarnessServices(services, machine)
    })
    // On failure the startup caller closes the app. Only the shared shutdown
    // barrier may release the owner, after any already-admitted work drains.
    return runtimeState.initialization
  }
  app.addHook('onListen', async () => {
    runtimeState.stopChatDelivery ??= chatDelivery.start()
    if (!runtimeState.initialized || runtimeState.closing || !harnessHost.installedClis) return
    runtimeState.nativeDefaultsInitialization ??= (async () => {
      await initializeNativeDefaults({
        pool: database.pool,
        options: harness => startupDatabase(() => nativeConfigurations.options(harness)),
        appMcpEndpoint,
        signal: startupLifetime.signal,
      })
      assertOpen()
      await startupDatabase(() => harnessRegistry.refreshMain())
      assertOpen()
      const initializedDefaults = await startupDatabase(() => foundationSettings.getAgentDefaults())
      const currentOperator = await startupDatabase(() => operators.ensure())
      if (!isDeepStrictEqual(currentOperator.configuration.harness, initializedDefaults.value.operator.harness)) {
        await startupDatabase(() => synchronizeOperatorDefaults(initializedDefaults.value.operator))
      }
    })()
    await runtimeState.nativeDefaultsInitialization
  })
  return { synchronizeOperatorDefaults, prepareSchema, initialize }
}

function createRuntimeHooks({ base, started, runtimeState, accountStage, repositoryStage, profileStage, conversationStage, operatorChatStage, agentChatStage, httpStage, controlStage }: ProductionServices) {
  const { config, database } = base
  const { bugReports } = accountStage
  const { runWorktrees } = repositoryStage
  const { appRoutes } = profileStage
  const { engine, interactions } = conversationStage
  const { chat } = operatorChatStage
  const { reviews } = agentChatStage
  const { app } = httpStage
  const { beginShutdown, lifecycle } = controlStage
  const SNAPSHOT_RELEASE_INTERVAL_MS = 10 * 60_000
  let lastSnapshotRelease = 0
  const commandReceiptRetention = new PostgresCommandReceiptRetention(database.pool)
  let lastReceiptCleanup = 0
  const reconcile = (report: (error: unknown) => void): Promise<void> => {
    if (runtimeState.closing) return Promise.resolve()
    if (runtimeState.reconciliation) return runtimeState.reconciliation
    runtimeState.reconciliation = trackService('run-reconciliation', { cadenceMs: 5_000, deadlineMs: 10 * 60_000 }, async () => {
      await bugReports.detectStuckExecutions(config.stuckExecutionIdleMs ?? DEFAULT_STUCK_EXECUTION_IDLE_MS)
      if (started.jobRuntime) await started.jobRuntime.reconcileFailedCaptures(report)
      started.jobRuntime?.startMaterializationReservationReconciliation(report)
      if (started.jobRuntime) await closeCompletedWorkflowSources(database.pool, started.jobRuntime.sources, report)
      // Age-based release is not urgent; storage pressure still releases on demand during approval and preparation.
      if (started.jobRuntime && Date.now() - lastSnapshotRelease >= SNAPSHOT_RELEASE_INTERVAL_MS) {
        lastSnapshotRelease = Date.now()
        await started.jobRuntime.sources.releaseUnusedSnapshots(report)
      }
      await engine.reconcile(report)
      if (runtimeState.closing) return
      await runWorktrees.cleanup(report)
      if (runtimeState.closing) return
      if (Date.now() - lastReceiptCleanup >= SNAPSHOT_RELEASE_INTERVAL_MS) {
        lastReceiptCleanup = Date.now()
        try { await commandReceiptRetention.prune() } catch (error) { report(error) }
      }
      if (runtimeState.initialized) {
        await appRoutes.refresh()
        if (runtimeState.closing) return
        await chat.reconcileActive()
        if (runtimeState.closing) return
        await reviews.tick()
      }
      let afterId: string | undefined
      do {
        if (runtimeState.closing) return
        const page = await interactions.recover({ limit: 100, ...(afterId ? { afterId } : {}) })
        for (const failure of page.errors) report(new Error(`Interaction ${failure.interactionId}: ${failure.error}`))
        afterId = page.nextCursor ?? undefined
      } while (afterId)
    }).finally(() => { runtimeState.reconciliation = undefined })
    return runtimeState.reconciliation
  }
  app.addHook('preClose', async () => {
    runtimeState.httpClosing = true
    beginShutdown()
    // Signal now, but do not release ownership before in-flight HTTP handlers
    // have drained. They may still finish native/DB lifecycle operations.
  })
  const drainShutdown = (): Promise<void> => {
    runtimeState.httpClosing = true
    beginShutdown()
    return lifecycle.finish()
  }
  // onClose hooks run last-registered first: this one runs after the drain below, whose Runs still call CI.
  app.addHook('onClose', async () => { await started.closeCiTransport?.() })
  app.addHook('onClose', async () => { await drainShutdown() })
  const shutdown = (): Promise<void> => {
    beginShutdown()
    // External callers close HTTP first. Repeated calls share app.close(), and
    // cannot release ownership while HTTP is draining in preClose.
    // onClose hooks must use drainShutdown(), not await this enclosing close.
    runtimeState.applicationClose ??= Promise.resolve().then(() => app.close())
    return runtimeState.applicationClose
  }
  return { reconcile, drainShutdown, shutdown }
}

async function initializeRuntimeOwner(services: ProductionServices, synchronizeOperatorDefaults: (template: RecordedAgentDefaults['operator']) => Promise<void>) {
  const { base, transport, repositoryStage, profileStage, conversationStage, operatorChatStage, operatorStage, controlStage } = services
  const { config } = base
  const { entrypoint, harnessHost, mainCodex } = transport
  const { foundationSettings, operators, remoteExecution } = repositoryStage
  const { appRoutes, harnessSettings } = profileStage
  const { operatorWorkingDirectory } = conversationStage
  const { chatAuthority } = operatorChatStage
  const { operatorServices } = operatorStage
  const { assertOpen, runtimeOwner, startupDatabase } = controlStage

  assertOpen()
  await runtimeOwner.acquire()
  assertOpen()
  await startupDatabase(() => remoteExecution.initialize())
  await entrypoint?.recover()
  assertOpen()
  if (harnessHost.installedClis) await mainCodex.initialize()
  assertOpen()
  const canonicalDirectory = await ensureOperatorRuntimeDirectory(config.harnesses.workspaceRoot)
  assertOpen()
  if (canonicalDirectory !== operatorWorkingDirectory) {
    throw new DomainError('OPERATOR_RUNTIME_DIRECTORY_INVALID', 'The canonical Operator directory differs from the configured managed path.', 422)
  }
  const operator = await startupDatabase(() => operators.ensure())
  assertOpen()
  const defaults = await startupDatabase(() => foundationSettings.getAgentDefaults())
  assertOpen()
  if (!isDeepStrictEqual(operator.configuration.harness, defaults.value.operator.harness)
    || !isDeepStrictEqual(operator.configuration.nativeTools, defaults.value.operator.nativeTools)) {
    await startupDatabase(() => synchronizeOperatorDefaults(defaults.value.operator))
    assertOpen()
  }
  await startupDatabase(() => chatAuthority.revokeOrphanedCredentials())
  await startupDatabase(() => appRoutes.refresh())
  assertOpen()
  await startupDatabase(() => harnessSettings.mcp.recover())
  assertOpen()
  await startupDatabase(() => operatorServices.runs.recoverSubagentCommands())
  assertOpen()
  await startupDatabase(() => harnessSettings.plugins.recover())
  assertOpen()

}


async function initializeJobServices(services: ProductionServices, machine: ProductionMainInstallation) {
  const { base, started, transport, accountStage, repositoryStage, executionStage, httpStage, deviceRuntime } = services
  const { config, database, infrastructure } = base
  const { fileStorageRoot, inputAcknowledgements, installedRsync, processRegistry, rsync, workerExecution } = transport
  const { commands } = accountStage
  const { locations } = repositoryStage
  const { approvals } = executionStage
  const { runtimeServices } = httpStage

  started.trustedConnections = new PostgresTrustedConnectionSetup(database.pool, machine.installationId)
  runtimeServices.trustedConnections = started.trustedConnections
  const activeNativeSession: SourceActiveNativeSessionReader = (sql, record) =>
    readSourceCurrentNativeSession(sql, record, approvals.passiveOwnedNativeSessions())
  const captureNativeSession: SourceNativeSessionCaptureReader = async record => {
    const captures = approvals.passiveOwnedNativeSessions()
    const readCurrent = async () => {
      return withTransaction(database.pool, async (sql) => {
        const proof = await readSourceCurrentNativeSession(sql, record, captures)
        return proof
      })
    }
    let proof = await readCurrent()
    if (!proof) return null
    const capture = captures.find(value => value.execution.id === record.receipt.executionId)!
    return { get proof() { return proof! }, signal: capture.signal, async assertCurrent() {
      capture.signal.throwIfAborted(); capture.assertCurrent()
      const current = await readCurrent()
      if (!sourceNativeSessionContinues(proof, current)) throw new DomainError('SOURCE_NATIVE_SESSION_CONFLICT', 'The original entered native owner or source lane is no longer current.', 409)
      proof = current
      capture.signal.throwIfAborted(); capture.assertCurrent()
    } }
  }
  const jobRuntime = await createProductionJobs({ pool: database.pool, commands, locations, mainId: machine.installationId,
    availableMemory: async profile => {
      const fingerprint = profile.measurement?.fingerprint
      if (!started.telemetry || !fingerprint) return null
      const registration = profile.root.registration
      return started.telemetry.service.availableComputerMemory({ hostRef: profile.root.selection.hostRef,
        applicationInstallationId: registration?.workerInstallationId ?? fingerprint.mainInstallationId,
        bootId: fingerprint.bootId, keyRevision: registration?.keyRevision ?? null,
        authorizationRevision: registration?.authorizationRevision ?? null }, AbortSignal.timeout(5000))
    },
    workerExecution,
    runtimeRoot: config.harnesses.workspaceRoot, storageRoot: fileStorageRoot, endpoint: () => deviceRuntime.endpointForDomains(),
    activeNativeSession, captureNativeSession,
    ...(installedRsync ? { transferReceiver:installedRsync.receiver,
      transferPreparationClosed: async closure => {
        if (rsync.kind !== 'configured') throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'Rsync cleanup is unavailable.', 409)
        await rsync.backend.retirePreparation(closure, AbortSignal.timeout(15_000))
      },
      transferMaterializationClosed: async record => {
        if (rsync.kind !== 'configured') throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'Rsync cleanup is unavailable.', 409)
        await rsync.backend.retireMaterialization(record, AbortSignal.timeout(15_000))
      },
      outputRsync:{stage:async(intent,signal)=>{
        if(rsync.kind!=='configured')throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE','The selected original rsync lifecycle is unavailable.',409)
        return rsync.backend.send(intent,undefined,signal)
      },acknowledge:async(intent,signal)=>{
        if(rsync.kind!=='configured')throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE','The selected original rsync lifecycle is unavailable.',409)
        await rsync.backend.acknowledge(intent,signal)
      }},
      inputRsync: { stage: async (intent, source, signal) => {
        if (rsync.kind !== 'configured') throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'The selected original rsync lifecycle is unavailable.', 409)
        return rsync.backend.send(intent, source, signal)
      }, acknowledge: async (intent, signal) => {
        if (rsync.kind !== 'configured') throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'The selected original rsync lifecycle is unavailable.', 409)
        if (inputAcknowledgements.has(intent.transferId)) throw new DomainError('JOB_INPUT_ACK_BUSY', 'Original input delivery ACK is already coordinating.', 409)
        inputAcknowledgements.set(intent.transferId, structuredClone(intent))
        try { await rsync.backend.acknowledge(intent, signal) } finally { inputAcknowledgements.delete(intent.transferId) }
      } },
      transferAcknowledged: async intent => {
        if (rsync.kind !== 'configured') throw new DomainError('RSYNC_COMPOSITION_UNAVAILABLE', 'The selected original rsync lifecycle is unavailable.', 409)
        await rsync.backend.acknowledge(intent)
      } } : {}),
    ...(processRegistry instanceof NativeProcessRegistry ? { nativeRegistry: processRegistry } : {}),
    ...(infrastructure?.jobs ? { infrastructure: infrastructure.jobs } : {}),
    ci: { enrollment: () => runtimeServices.ciEnrollment, runtime: () => runtimeServices.ciRuntime } })
  started.jobRuntime = jobRuntime
  return jobRuntime
}


async function initializeWorkflowArtifacts(services: ProductionServices, machine: ProductionMainInstallation, jobRuntime: JobRuntime) {
  const { base, started, transport, accountStage, repositoryStage, profileStage, httpStage, controlStage, deviceRuntime } = services
  const { database, infrastructure } = base
  const { access, workerExecution } = transport
  const { providerAccounts, workflowCapture } = accountStage
  const { harnessRegistry, locations, remoteWorkflow, selectedSuites } = repositoryStage
  const { harnessInstances, installationMonitor } = profileStage
  const { app } = httpStage
  const { mountArtifacts } = controlStage

  if (selectedSuites) {
    const agentPlacement = new AgentPlacementProducer(database.pool, machine.installationId, jobRuntime.sources, jobRuntime.policies,
      harnessRegistry, { codex: selectedSuites.codex.revision },
      workerExecution, profile => harnessInstances.ensureReady(profile),
      (hosts, signal) => installationMonitor.refreshHosts(hosts, signal), providerAccounts, async host => {
        if (host.kind === 'device') await deviceRuntime.endpointForDomains().assertWorkerBundleReady(host.deviceId)
      })
    started.agentPlacement = agentPlacement
    started.agentPreparation = new AgentExecutionPreparation(jobRuntime.sources, agentPlacement)
    started.executionAuthority = createExecutionAuthorityExtension(database.pool, locations, agentPlacement)
  }
  const artifactPorts: NativeArtifactAuthorityPorts = { locations,
    producer: { assertPinsCurrent: (...args) => {
      if (!started.agentPlacement) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The actual artifact placement producer is unavailable.', 503)
      return started.agentPlacement.assertPinsCurrent(...args)
    } } }
  const artifactAuthority = new PostgresArtifactPublicationAuthority(machine.installationId, database.pool, artifactPorts)
  started.localWorkflowArtifacts = new LocalWorkflowArtifacts(database.pool,
    new LocalWorkflowArtifactAuthority(machine.installationId, database.pool, locations, artifactPorts.producer), () => {
      if (!started.fileStorage) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE',
        'Local workflow artifact storage is unavailable.', 503)
      return started.fileStorage
    })
  const outputAuthorization = infrastructure?.nativeOutputAuthorization?.(artifactAuthority)
    ?? createWorkerNativeOutputAuthorizationPort(artifactAuthority, workerNativeOutputContext({ artifactAuthority, devices: deviceRuntime }))
  started.mainWorkerMcp = new MainWorkerMcpRelay(machine.installationId, database.pool, access, selectedMainMcpForward(app), outputAuthorization)
  started.artifactOutputsGate = createWorkflowArtifactOutputsGate(machine.installationId, artifactAuthority)
  started.artifactResultSource = createProductionWorkflowArtifactResultSource({ captures: workflowCapture.verify,
    physical: remoteWorkflow, authority: artifactAuthority })
  started.admitWorkflowFileContext = createProductionWorkflowFileContexts(machine.installationId, { captures: workflowCapture.verify,
    assertPhysical: remoteWorkflow.assertPhysical, authority: artifactAuthority, transferContext: remoteWorkflow.fileTransferContext })
  started.artifactComposition = { mainId: machine.installationId, authority: artifactAuthority,
    fence: new PostgresAcceptedArtifactAttemptFence(machine.installationId, artifactPorts) }
  mountArtifacts()

}


async function initializeComputerServices(services: ProductionServices, machine: ProductionMainInstallation, jobRuntime: JobRuntime) {
  const { base, started, runtimeState, transport, browserStage, accountStage, repositoryStage, profileStage, httpStage, controlStage, deviceRuntime } = services
  const { computerUpkeep, config, database } = base
  const { mainCodex } = transport
  const { browser } = browserStage
  const { commands } = accountStage
  const { projectRoot } = repositoryStage
  const { harnessSettings, maintenancePorts } = profileStage
  const { app, runtimeServices } = httpStage
  const { assertOpen, runtimeOwner, startupDatabase } = controlStage

  await startupDatabase(() => bootstrapLocalMainWorkspaceRoot({ pool: database.pool, policies: jobRuntime.policies,
    mainId: machine.installationId, runtimeRoot: config.harnesses.workspaceRoot, appStorageRoot: projectRoot }))
  const workspaceRoots = runtimeServices.workspaceRoots = new WorkspaceBoundLocationService(
    database.pool, commands, jobRuntime.policies,
  )
  started.rootPolicies = jobRuntime.policies
  runtimeServices.sources = jobRuntime.sources
  runtimeServices.workspaceRepositories = new WorkspaceRepositoryService(database.pool, commands,
    runtimeServices.workspaces, runtimeServices.workspaceRoots, jobRuntime.policies, jobRuntime.sources,
    machine.installationId, projectRoot)
  const { clouds, discoverClouds, circleCredits, circleStandby } = await initializeCircleCi(services, machine)
  runtimeServices.computerActivity = new ComputerActivityService(database.pool, machine.installationId,
    id => deviceRuntime.presenceFor(id), commands, clouds, circleCredits)
  const computerAccounts = runtimeServices.computerAccounts = new ComputerAccountsService(database.pool, machine.installationId,
    () => deviceRuntime.endpointForDomains(), commands)
  const computerMaintenance = runtimeServices.computerMaintenance = new FleetMaintenanceService(database.pool, machine.installationId,
    () => deviceRuntime.endpointForDomains(), commands, new ComputerMaintenance({ ...maintenancePorts, browserRuntime: {
      status: () => browser.runtime.status(), retry: async () => {
        const status = await browser.runtime.retry(); browser.profiles.wake(); return status
      } } }), {
      workerManifestSha256s: () => readProductionWorkerManifestSha256s({ environment: process.env,
        releaseDirectory: fileURLToPath(new URL('../../../', import.meta.url)) }),
      workerContentSha256s: () => readProductionWorkerContentSha256s({ environment: process.env,
        releaseDirectory: fileURLToPath(new URL('../../../', import.meta.url)) }),
      workerPublication: () => readProductionWorkerReleasePublication({ environment: process.env,
        releaseDirectory: fileURLToPath(new URL('../../../', import.meta.url)) }),
      connections: computerConnectionsReader(computerAccounts, {
        list: (principal, harness, hostRef) => harnessSettings.mcp.list(principal, harness, hostRef),
        readMainClaudeServers: () => claudeUserMcpServers(maintenancePorts),
      }),
      codexUserMcpServers: () => harnessSettings.mcp.userServers('codex'),
      claudeUserMcpServers: () => claudeUserMcpServers(maintenancePorts),
      claudePlugins: async () => await maintenancePorts.find('claude')
        ? readClaudePlugins(maintenancePorts, AbortSignal.timeout(120_000)) : { plugins: [], marketplaces: [] },
      // Plugins from a local marketplace exist only on Main, so they are not copied to other computers.
      codexPlugins: async () => {
        if (!await maintenancePorts.find('codex')) return []
        const [plugins, marketplaces] = await Promise.all([
          installedPlugins(maintenancePorts, mainCodex.binary, AbortSignal.timeout(120_000)),
          pluginMarketplaces(maintenancePorts, mainCodex.binary, AbortSignal.timeout(60_000))])
        const local = new Set(marketplaces.filter(marketplace => marketplace.local).map(marketplace => marketplace.name))
        return plugins.filter(plugin => !local.has(plugin.pluginId.split('@').at(-1)!))
      },
      codexMarketplaces: async () => await maintenancePorts.find('codex')
        ? (await pluginMarketplaces(maintenancePorts, mainCodex.binary, AbortSignal.timeout(60_000)))
          .flatMap(marketplace => marketplace.gitSource ? [{ name: marketplace.name, source: marketplace.gitSource }] : []) : [],
    })
  if (runtimeState.closing) computerMaintenance.stopAdmission()
  // Keep harnesses current and Main's MCP servers and plugins on every computer.
  if (computerUpkeep) {
    const upkeep = () => { void trackService('computer-upkeep', { cadenceMs: 6 * 60 * 60_000, deadlineMs: 2 * 60 * 60_000 },
      () => computerMaintenance.keepCurrent()).catch(error => app.log.warn({ err: error }, 'Computer upkeep failed')) }
    const firstUpkeep = setTimeout(upkeep, 120_000)
    const upkeepTimer = setInterval(upkeep, 6 * 60 * 60_000)
    // MCP server and plugin changes on Main reach the other computers within about a minute.
    const stopSourceSync = startWorkerPublicationSync(workerArtifactLocation({ environment: process.env,
      releaseDirectory: fileURLToPath(new URL('../../../', import.meta.url)) }),
    () => trackService('fleet-source-sync', { cadenceMs: 60_000, deadlineMs: 30 * 60_000 },
      () => computerMaintenance.syncChangedSources()),
    error => app.log.warn({ err: error }, 'Fleet MCP and plugin sync failed'))
    firstUpkeep.unref(); upkeepTimer.unref()
    runtimeState.stopComputerTimers = () => {
      clearTimeout(firstUpkeep)
      clearInterval(upkeepTimer)
      stopSourceSync()
    }
    if (runtimeState.closing) runtimeState.stopComputerTimers()
  }
  runtimeServices.computerGitHub = new ComputerGitHubService(database.pool, machine.installationId,
    () => deviceRuntime.endpointForDomains(), commands, {
      accountChanged: target => computerAccounts.invalidate(target),
    })
  const computerSync = runtimeServices.computerSync = new ComputerSyncService(database.pool, machine.installationId,
    () => deviceRuntime.endpointForDomains(), commands, undefined, () => {
      assertOpen()
      if (!runtimeOwner.active) throw new DomainError('NATIVE_RUNTIME_UNAVAILABLE', 'Shared file sync requires the runtime owner.', 503)
    })
  const syncTimer = setInterval(() => {
    void trackService('computer-sync', { cadenceMs: 30_000, deadlineMs: 10 * 60_000 },
      () => computerSync.poll()).catch(error => {
      app.log.warn({ err: error }, 'Shared file sync setup is pending')
    })
  }, 30_000)
  syncTimer.unref()
  runtimeState.stopSyncTimer = () => { clearInterval(syncTimer) }
  if (runtimeState.closing) { runtimeState.stopSyncTimer(); computerSync.stopAdmission() }
  runtimeServices.buildComputers = jobRuntime.buildComputers
  runtimeServices.jobs = jobRuntime.jobs
  const readAgentFiles = agentFileReader(() => deviceRuntime.endpointForDomains())

  return { clouds, discoverClouds, readAgentFiles, workspaceRoots, circleCredits, circleStandby }
}


async function initializeCircleCi(services: ProductionServices, machine: ProductionMainInstallation) {
  const { base, accountStage, repositoryStage, httpStage } = services
  const { database } = base
  const { commands } = accountStage
  const { foundationSettings } = repositoryStage
  const { runtimeServices } = httpStage
  const { circleAccounts, ...circleCi } = await createCircleCi({ pool: database.pool, mainId: machine.installationId,
    foundationSettings, commands })
  runtimeServices.circleAccounts = circleAccounts
  return circleCi
}


async function initializeCiServices(
  services: ProductionServices,
  machine: ProductionMainInstallation,
  jobRuntime: JobRuntime,
  computerServices: {
    clouds: CloudCis
    discoverClouds: () => Promise<void>
    readAgentFiles: ReadAgentFiles
    workspaceRoots: WorkspaceBoundLocationService
    circleCredits: CircleCreditUsage
    circleStandby: CircleStandby
  },
) {
  const { base, started, runtimeState, transport, accountStage, httpStage, controlStage, deviceRuntime } = services
  const { database } = base
  const { workerExecution } = transport
  const { commands } = accountStage
  const { app, runtimeServices } = httpStage
  const { assertOpen, startupDatabase } = controlStage
  const { clouds, discoverClouds, readAgentFiles, workspaceRoots, circleCredits, circleStandby } = computerServices
  // Stopped with the runtime so a start our shutdown interrupts is resumed, not failed.
  started.cloudCis = clouds

  const hostCi = createHostCi({ pool: database.pool, mainId: machine.installationId, commands,
    devices: () => deviceRuntime.endpointForDomains(), workerExecution, clouds, discoverClouds, readAgentFiles,
    circleCredits, circleStandby })
  const ciTransport = await createCiHttpTransport(hostCi)
  const ci = ciTransport.client
  started.hostCi = ci
  hostCi.start()
  started.closeCiTransport = ciTransport.close
  app.addHook('onClose', async () => { await hostCi.close() })
  const stopDeadlineSweeper = startStateDeadlineSweeper(database.pool, {
    ciRuns: now => ci.expireOverdueRuns(now),
    workerPublication: () => readProductionWorkerReleasePublication({ environment: process.env,
      releaseDirectory: fileURLToPath(new URL('../../../', import.meta.url)) }) })
  app.addHook('onClose', async () => { stopDeadlineSweeper() })
  runtimeServices.ci = ci
  runtimeServices.jobRuntimeProfiles = jobRuntime.profiles
  const ciRuntime = runtimeServices.ciRuntime = new CiRuntimeProvisioner(database.pool, jobRuntime.profiles, jobRuntime.sources,
    () => deviceRuntime.endpointForDomains(), commands, { changed: () => jobRuntime.jobs.requestQueueWake(),
      main: () => jobRuntime.mainCiRuntime })
  runtimeServices.ciEnrollment = new CiEnrollment(database.pool, commands, jobRuntime.profiles,
    ciRuntime, new ProductionCiEnrollmentInventory(database.pool, jobRuntime.sources,
      () => deviceRuntime.endpointForDomains(), () => jobRuntime.mainCiRuntime, workerExecution,
      new ManagedWorkspaceRootService(commands, workspaceRoots, jobRuntime.policies)),
    () => { if (!runtimeState.closing) void ci.dispatch().catch(error => app.log.error({ err: error }, 'CI dispatch failed')) })
  runtimeServices.ciEnrollment.request()
  const enrollmentTimer = setInterval(() => runtimeServices.ciEnrollment?.request(), 30_000)
  enrollmentTimer.unref()
  app.addHook('onClose', async () => {
    clearInterval(enrollmentTimer)
    await runtimeServices.ciEnrollment?.close()
  })
  await startupDatabase(() => ciRuntime.recover())
  jobRuntime.jobs.requestQueueWake()
  assertOpen()

}


async function initializeHarnessServices(services: ProductionServices, machine: ProductionMainInstallation) {
  const { base, started, runtimeState, transport, accountStage, repositoryStage, qualificationStage, profileStage, executionStage, agentChatStage, httpStage, controlStage, deviceRuntime } = services
  const { database } = base
  const { processRegistry } = transport
  const { commands } = accountStage
  const { harnessRegistry, remoteWorkflow } = repositoryStage
  const { harnessCompatibility, harnessQualifications, qualificationRegistry } = qualificationStage
  const { harnessCatalog, harnessSettings, installationMonitor, launches, nativeConfigurations } = profileStage
  const { approvals, telemetryLifetime } = executionStage
  const { agentChat } = agentChatStage
  const { app, runtimeServices } = httpStage
  const { assertOpen, runtimeOwner, startupDatabase } = controlStage

  started.managedMcp = new DeviceManagedMcp(database.pool, machine.installationId,
    () => deviceRuntime.endpointForDomains(), commands)
  await startupDatabase(() => harnessRegistry.initialize(machine.installationId))
  assertOpen()
  if (processRegistry instanceof NativeProcessRegistry) {
    const registry = processRegistry
    const mainTelemetryContext: Extract<TrustedTelemetryContext, { kind: 'main-local' }> = { kind: 'main-local', mainId: machine.installationId,
      // Approved canonical alias for the Main, not a separate hardware UUID.
      deviceId: machine.installationId, applicationInstallationId: machine.installationId,
      bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(),
      runtimeEpoch: await startupDatabase(() => runtimeOwner.readRuntimeEpoch()), capability: RESOURCE_TELEMETRY_CAPABILITY }
    const authorities = createPassiveTelemetryAuthorities({ pool: database.pool, registry,
      mainContext: () => mainTelemetryContext, mainActive: () => !runtimeState.closing && runtimeOwner.active,
      deviceBinding: id => deviceRuntime.currentBinding(id), presence: id => deviceRuntime.presenceFor(id),
      deviceCapabilities: id => deviceRuntime.endpointForDomains().capabilities(id),
      getRemoteNativeOwners: () => remoteWorkflow.getRemoteNativeOwners(),
      getNativeOwners: () => approvals.passiveOwnedNativeSessions().flatMap(owned => {
        const captured = launches.scopeOf(owned.manager)
        return captured ? [{ execution: owned.execution, session: owned.session, writer: owned.writer, generation:owned.generation, assertCurrent: owned.assertCurrent, nativeOwner: captured.owner }] : []
      }) })
    const telemetry = await createResourceTelemetryRuntime({ localContext: mainTelemetryContext, registry, ...authorities,
      // A Main inside a container sees only its namespace, never the whole computer.
      wholeHostVisible: !existsSync('/.dockerenv') && !existsSync('/run/.containerenv'), signal: telemetryLifetime.signal })
    started.telemetry = telemetry
    runtimeServices.resourceTelemetry = { reads: telemetry.service, selectors: telemetry.selectors }
    void telemetry.completion.then(result => {
      if (result.kind !== 'failed') return
      reportServiceFailure('telemetry-collector', result.error)
      app.log.error({ err: result.error }, 'passive resource telemetry collector failed')
    })
    assertOpen()
  }
  // Optional discovery warmups used to block startup on native auth/network.
  // Qualification still runs at every existing on-demand configuration/execution gate.
  // The bounded compatibility diagnostic creates no native session or model turn.
  if (qualificationRegistry && harnessQualifications) {
    await qualificationRegistry.load(startupDatabase)
  }
  harnessCompatibility.start()
  assertOpen()
  registerApiRoutes(app, productionRoutes(httpStage, started))
  runtimeState.initialized = true
  // Reconcile chat turns interrupted by the previous process; never blocks startup.
  void agentChat.recover().catch((error: unknown) => app.log.error({ err: error }, 'agent chat recovery failed'))
  // Fill the settings status and model caches in the background so first reads do not wait on native checks.
  void Promise.allSettled([harnessCatalog.warmup(), nativeConfigurations.options('codex'), nativeConfigurations.options('claude'),
    harnessSettings.mcp.warmup(['codex']), harnessSettings.plugins.warmup(), harnessSettings.claudePlugins.warmup()])
  // Deployment can change the launcher or environment; restore a previously qualified Codex binary.
  if (harnessQualifications) void harnessQualifications.restore('codex').catch((error: unknown) =>
    app.log.warn({ err: error }, 'Main Codex requalification after restart failed'))
  installationMonitor.start(machine.installationId)
}


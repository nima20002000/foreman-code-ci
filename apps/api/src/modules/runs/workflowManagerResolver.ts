import type pg from 'pg'
import { HarnessExecutionRequestSchema, RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import type { AcceptedProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { DomainError } from '../errors.js'
import { qualifyCodex } from '../harnesses/index.js'
import type { AcceptedClaudeProfileAdmission, AcceptedHarnessProfileAdmission } from '../harnesses/index.js'
import type { NativeLaunchRecords } from '../harnesses/index.js'
import { runCommand } from '../harnesses/index.js'
import { productionClaudeManager, type ClaudeProfileOwner } from '../harnesses/index.js'
import type { ProductionHarnessInfrastructure } from '../harnesses/index.js'
import type { ProductionHarnessRegistry } from '../harnesses/index.js'
import type { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import type { NativeHarnessFactories } from '../harnesses/index.js'
import { productionSelectedProfileManager } from '../harnesses/index.js'
import { workflowProfileSelection } from '../harnesses/index.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../interactions/runtimePorts.js'
import type { createProductionRemoteWorkflow } from '../placement/index.js'
import type { ProviderAccountsService } from '../provider-accounts/service.js'
import { createLocalWorkflowNativeOutputs } from './remote/localWorkflowNativeOutputs.js'
import type { LocalWorkflowArtifacts } from './remote/localWorkflowArtifacts.js'
import type { PostgresRunRepository } from './postgres.js'

export interface WorkflowManagerResolverDependencies {
  pool: pg.Pool
  /** 'replay' runs recorded harness protocol instead of the native SDK. */
  harnessMode: 'native' | 'replay'
  claudeClient: NonNullable<ProductionHarnessInfrastructure['claudeClient']> | undefined
  fileStorageRoot: string
  processRegistry: Pick<NativeProcessRegistry, 'scope' | 'reserveLaunch' | 'abandonReservedLaunch' | 'closeOwner'>
  /** Provider-account bindings accepted per execution, filled as executions prepare. */
  workflowAccountBindings: Map<string, AcceptedProviderAccountBinding>
  remoteWorkflow: ReturnType<typeof createProductionRemoteWorkflow>
  /** Local workflow artifact storage; throws while startup has not opened it. */
  localWorkflowArtifacts: () => LocalWorkflowArtifacts
  nativeFactories: NativeHarnessFactories
  harnessRegistry: ProductionHarnessRegistry
  providerAccounts: ProviderAccountsService
  claudeProfiles: AcceptedClaudeProfileAdmission<ClaudeProfileOwner>
  selectedProfiles: AcceptedHarnessProfileAdmission<ClaudeProfileOwner>
  runs: Pick<PostgresRunRepository, 'get' | 'getExecution'>
  /** Receives every manager's recovery scope, and the Claude launch behind a Claude manager. */
  launches: NativeLaunchRecords
}

/** Allocates the native manager of one workflow execution (or consultation), local or on a paired computer. */
export function createWorkflowManagerResolver(dependencies: WorkflowManagerResolverDependencies): ExecutionScopedNativeSessionManagerResolver {
  const { pool, harnessMode, claudeClient, fileStorageRoot, processRegistry, workflowAccountBindings, remoteWorkflow,
    localWorkflowArtifacts, nativeFactories, harnessRegistry, providerAccounts, claudeProfiles, selectedProfiles, runs, launches } = dependencies
  return new ExecutionScopedNativeSessionManagerResolver((context, getOwner) => {
    const configuration = context.configuration.harness
    const acceptedAccount = workflowAccountBindings.get(context.executionId)
    const accountBinding = acceptedAccount?.kind === 'slot' ? acceptedAccount : undefined
    if (configuration.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    }
    if (configuration.harness !== context.harness) {
      throw new DomainError('HARNESS_CONFIGURATION_MISMATCH', 'The pinned configuration does not match the execution harness.', 409)
    }
    const remoteAccount = context.acceptedPlacement?.hostRef.kind === 'device'
      || context.configuration.harnessProfileSelection?.target.hostRef.kind === 'device'
    if (configuration.accountId && remoteAccount) {
      throw new DomainError('PROVIDER_ACCOUNT_LOCAL_ONLY', 'Managed provider accounts cannot run on another computer.', 409)
    }
    // Object allocation remains native/registry IO-free. The coordinator reserves
    // this SAME scope immediately before its lifetime/entered commits.
    const processOwner = context.purpose === 'consultation' && context.consultation
      ? `consultation:${context.consultation.consultationId}` : `execution:${context.executionId}`
    const recovery = processRegistry.scope(processOwner)
    const remote = remoteWorkflow.manager(context, getOwner)
    if (remote) return remote
    const nativeOutputs = configuration.harness === 'codex' && context.artifactOutputs && !context.purpose
      ? createLocalWorkflowNativeOutputs({ executionId: context.executionId, artifacts: localWorkflowArtifacts,
        stateDirectory: fileStorageRoot, assertCurrent: async signal => {
        signal?.throwIfAborted()
        const owner = getOwner()
        if (!owner || owner.runId !== context.runId) throw new DomainError('RUN_OWNERSHIP_LOST',
          'The local workflow no longer owns its native output turn.', 409)
        owner.assertOwned()
      }, qualification: { registry: processRegistry, qualify: qualifyCodex, command: runCommand } }) : undefined
    const selector = workflowProfileSelection(context,
      remoteWorkflow.binding(context.executionId)?.executionPlacement?.workingTree.canonicalCwd)
    if (configuration.harness === 'claude') {
      if (!context.runId || !context.attempt) throw new DomainError('CLAUDE_OWNER_UNAVAILABLE',
        'Claude requires the persisted Run and execution attempt.', 409)
      const claude = productionClaudeManager({ pool, factories: nativeFactories, registry: harnessRegistry,
        accounts: providerAccounts,
        ...(accountBinding ? { accountBinding } : {}),
        profiles: claudeProfiles, ...(selector ? { selector } : {}),
        binding: { kind: 'workflow', runId: context.runId, executionId: context.executionId, attempt: context.attempt, getOwner },
        ...(context.consultation ? { consultation: context.consultation } : {}),
        role: 'workflow', configuration, workingDirectory: context.workingDirectory, ownerAgentId: context.agentId,
        recovery, appMcpAccess: 'scoped', mode: harnessMode,
        ...(claudeClient ? { loadClient: claudeClient } : {}),
        inspectionStart: async () => {
          const owner = getOwner()
          if (!owner) throw new DomainError('CLAUDE_OWNER_UNAVAILABLE', 'The workflow native owner is unavailable.', 409)
          const execution = await runs.getExecution(context.executionId, owner), run = await runs.get(context.runId!, owner)
          if (!execution || !run || execution.attempt !== context.attempt) throw new DomainError('CLAUDE_OWNER_UNAVAILABLE', 'The persisted execution attempt changed.', 409)
          const request = HarnessExecutionRequestSchema.parse({ ...context.workflowRequest,
            executionId: execution.id, runId: execution.runId,
            workspaceId: run.workspaceId, workflowNodeId: execution.workflowNodeId, workingDirectory: execution.workingDirectory,
            runtimeDirectory: execution.runtimeDirectory, configuration: context.configuration, input: execution.input })
          return execution.nativeSessionId ? { kind: 'workflow', correlationId: `execution:${execution.id}`, request }
            : { request, correlationId: `execution:${execution.id}` }
        },
      })
      launches.recordClaude(claude)
      launches.recordScope(claude.manager, recovery)
      return claude.manager
    }
    if (selector) {
      if (!context.runId || !context.attempt) throw new DomainError('HARNESS_PROFILE_OWNER_CONFLICT', 'The exact Run attempt is unavailable.', 409)
      const { manager } = productionSelectedProfileManager({ factories: nativeFactories, registry: harnessRegistry, profiles: selectedProfiles,
        ...(accountBinding ? { accountBinding } : {}),
        selector, binding: { kind: 'workflow', runId: context.runId, executionId: context.executionId, attempt: context.attempt, getOwner,
          ...(context.purpose ? { purpose: context.purpose } : {}),
          ...(context.consultation ? { consultation: context.consultation } : {}) },
        configuration, role: 'workflow', workingDirectory: context.workingDirectory, ownerAgentId: context.agentId,
        recovery, appMcpAccess: 'scoped', ...(nativeOutputs ? { nativeOutputs } : {}) })
      launches.recordScope(manager, recovery)
      return manager
    }
    const selection = harnessRegistry.initialized ? harnessRegistry.pinAccepted(context.configuration) : undefined
    const { manager } = nativeFactories.allocate({
      ...(accountBinding ? { accountBinding } : {}),
      ...(selection ? { selection } : {}),
      role: 'workflow', workingDirectory: context.workingDirectory, ownerAgentId: context.agentId,
      configured: { instanceId: selection?.instance.instanceId ?? context.agentId, instanceRevision: context.configuration.id, driverId: configuration.harness,
        enabled: true, configuration },
      processRecovery: recovery, appMcpAccess: 'scoped',
      harness: 'codex',
      ...(nativeOutputs ? { nativeOutputs } : {}),
    })
    launches.recordScope(manager, recovery)
    return manager
  })
}

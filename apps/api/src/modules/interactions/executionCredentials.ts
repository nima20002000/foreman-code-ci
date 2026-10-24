import { INSTALLATION_NAMES } from '@foreman-code/contracts/installation-names'
import type pg from 'pg'
import { DomainError } from '../errors.js'
import type { PostgresAccessService } from '../access/index.js'
import { prepareClaudeWorkflowCredentials } from '../harnesses/claudeSdk/workflowCredentials.js'
import type { AppMcpRoutes } from '../harnesses/appMcpRoutes.js'
import { McpDetectionService, WorkerLaunchCredentialService, type ExecutionCredentialProvider } from '../harnesses/mcpDetection.js'
import type { NativeLaunchRecords } from '../harnesses/nativeLaunchRecords.js'
import type { NativeHarnessFactories } from '../harnesses/runtimeFactory.js'
import type { placedContinuationValidator } from '../placement/continuation.js'
import type { createProductionRemoteWorkflow } from '../placement/productionRemoteWorkflow.js'
import { remoteMcpPreflight } from '../placement/remoteMcpPreflight.js'
import type { PostgresRunRepository } from '../runs/index.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import { readRetainedRemoteReviewer } from './retainedRemoteReviewer.js'
import type { ExecutionScopedNativeSessionManagerResolver, NativeManagerResolutionContext } from './runtimePorts.js'
import type { CurrentWorkerCredentialService } from './current/credentials.js'

export interface ExecutionCredentialDependencies {
  pool: pg.Pool
  access: Pick<PostgresAccessService, 'authenticate'>
  credentials: CurrentWorkerCredentialService
  /** The MCP routes the credentials unlock; refreshed whenever a credential is issued or restored. */
  appRoutes: Pick<AppMcpRoutes, 'refresh'>
  /** True once shutdown has begun; renewals then skip the route refresh. */
  isClosing: () => boolean
  validateContinuation: ReturnType<typeof placedContinuationValidator>
  runs: Pick<PostgresRunRepository, 'get' | 'getExecution' | 'getExecutionConfiguration'>
  remoteWorkflow: ReturnType<typeof createProductionRemoteWorkflow>
  locations: Pick<WorkspaceLocationService, 'runnerId'>
  managers: Pick<ExecutionScopedNativeSessionManagerResolver, 'resolve'>
  nativeFactories: NativeHarnessFactories
  appMcpEndpoint: string
  prepareWorkflowManagerContext: (context: NativeManagerResolutionContext) => Promise<NativeManagerResolutionContext>
  launches: NativeLaunchRecords
}

/** Issues, restores, renews and revokes the credential an execution's native process holds. */
export function createExecutionCredentialProvider(dependencies: ExecutionCredentialDependencies): ExecutionCredentialProvider {
  const { pool, access, credentials, appRoutes, isClosing, validateContinuation, runs, remoteWorkflow, locations, managers,
    nativeFactories, appMcpEndpoint, prepareWorkflowManagerContext, launches } = dependencies
  return {
    async restoreConsultation(binding, environment) {
      const credential = await credentials.restoreForConsultation(binding, environment)
      await appRoutes.refresh()
      return credential
    },
    async renewConsultation(binding, credential, signal) {
      signal?.throwIfAborted()
      const expiresAt = await credentials.renewForConsultation(binding, credential)
      if (!isClosing()) await appRoutes.refresh({ signal })
      return expiresAt
    },
    async restore(executionId, environment) {
      await validateContinuation(executionId)
      const credential = await credentials.restoreForExecution(executionId, environment)
      await appRoutes.refresh()
      return credential
    },
    async recoverRemote(executionId, applicationAccess, job) {
      const execution = await runs.getExecution(executionId)
      const binding = remoteWorkflow.binding(executionId)
      const retained = execution && await readRetainedRemoteReviewer(pool, execution)
      if (!execution || !binding || !retained || applicationAccess.executionId !== executionId
        || applicationAccess.operationId !== binding.intent.operationId || applicationAccess.attemptId !== binding.intent.attemptId
        || applicationAccess.bindingHash !== binding.intent.bindingHash || applicationAccess.agentId !== execution.agentId)
        throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The original process credential cannot be recovered.', 409)
      if (job) await credentials.bindReviewerJob(executionId, { principalId: retained.principalId }, job)
      const principal = await access.authenticate(applicationAccess.token, 'worker')
      if (principal.id !== retained.principalId || principal.agentId !== execution.agentId)
        throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The original process credential changed.', 409)
      return { principalId: principal.id, expiresAt: principal.expiresAt,
        environment: { agentId: execution.agentId, variables: { [INSTALLATION_NAMES.environment.MCP_TOKEN]: applicationAccess.token } } }
    },
    async bindReviewerJob(executionId, credential, job, lane) {
      await credentials.bindReviewerJob(executionId, credential, job, lane)
      await appRoutes.refresh()
    },
    async prepare(input) {
      await validateContinuation(input.executionId, input.signal)
      const execution = await runs.getExecution(input.executionId)
      if (!execution || execution.workingDirectory !== input.workingDirectory) {
        throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'Credential preflight must use the accepted execution directory.', 409)
      }
      const configuration = await runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
      const run = await runs.get(execution.runId)
      if (!configuration || configuration.id !== execution.agentConfigurationVersionId
        || configuration.agentId !== execution.agentId || configuration.harness.harness !== input.harness
        || !run?.executionLocation) {
        throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'Credential preflight requires the pinned execution identity.', 409)
      }
      const context = {
        executionId: execution.id, agentId: execution.agentId, harness: input.harness,
        workingDirectory: input.workingDirectory, configuration, runId: execution.runId, attempt: execution.attempt,
        ...(input.purpose ? { purpose: input.purpose } : {}),
        ...(input.consultation ? { consultation: input.consultation } : {}),
      }
      const preparedContext = await prepareWorkflowManagerContext(context)
      const placement = preparedContext.acceptedPlacement
      if (!placement && run.executionLocation.runnerId !== locations.runnerId) {
        throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'An unplaced execution requires the local workspace runner.', 409)
      }
      let runnerId = run.executionLocation.runnerId
      if (placement?.hostRef.kind === 'main') runnerId = locations.runnerId
      if (placement?.hostRef.kind === 'device') runnerId = placement.registration!.workerInstallationId
      const manager = input.manager ?? managers.resolve(preparedContext).manager
      const detection = remoteWorkflow.isRemote(input.executionId)
        ? remoteMcpPreflight(manager, preparedContext)
        : new McpDetectionService(nativeFactories.inspector(manager), appMcpEndpoint)
      if (input.harness === 'claude') {
        const claude = launches.claudeOf(manager)
        if (!claude || configuration.harness.harness !== 'claude') throw new DomainError('CLAUDE_OWNER_UNAVAILABLE', 'The exact Claude launch is unavailable.', 409)
        return prepareClaudeWorkflowCredentials({ input, configuration: configuration.harness, claude,
          inspector: nativeFactories.inspector(manager), detection, credentials, runnerId, endpoint: appMcpEndpoint,
          refreshRoutes: () => appRoutes.refresh({ signal: input.signal }) })
      }
      const launch = new WorkerLaunchCredentialService(detection, credentials, runnerId)
      // The coordinator reserved and retained this exact manager lifetime
      // BEFORE preflight. It owns disposal + durable closure on every failure;
      // releasing an empty resolver here would destroy the only positive proof.
      const prepared = await launch.prepare(input)
      try { await appRoutes.refresh({ signal: input.signal }) } catch (error) { await credentials.revoke(prepared.credential); throw error }
      return prepared
    },
    revoke: (credential) => credentials.revoke(credential),
    revokeForExecution: (executionId) => credentials.revokeForExecution(executionId),
    revokeForRun: (runId, client) => credentials.revokeForRun(runId, client),
    reconcileTerminalCredentials: () => credentials.reconcileTerminalCredentials(),
    renew: async (executionId, credential, signal) => {
      signal?.throwIfAborted()
      const expiresAt = await credentials.renewForExecution(executionId, credential)
      if (!isClosing()) await appRoutes.refresh({ signal })
      return expiresAt
    },
  
  }
}

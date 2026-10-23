import { AsyncLocalStorage } from 'node:async_hooks'
import { late, type Late } from '../../composition/late.js'
import { hostEnvironment } from '../../shared/process.js'
import { isWorkerAdmission, requiresWorkerBundle } from './workerAdmission.js'
import { createInstalledWorkerManagedMcp } from '../harnesses/installedWorkerManagedMcp.js'
import { createWorkerManagedMcpExtension } from '../harnesses/workerManagedMcp.js'
import { createInstalledWorkerAccounts } from '../provider-accounts/index.js'
import { createProviderAccountWorkerExtension, workerProviderAccountResolver, type WorkerAccountOperationPorts } from '../provider-accounts/index.js'
import { inventoryPayloadFingerprints } from '../harnesses/payloadFingerprintCache.js'
import { realpath, stat } from 'node:fs/promises'
import type { TransferIntent } from '@foreman-code/contracts/byte-transfer'
import { setTimeout as wait } from 'node:timers/promises'
import { SourceReservationReclamationAuthorityResponseSchema } from '@foreman-code/contracts/source-operations'
import { hasPositiveRemoteEntryClosure, hasPositiveRemoteNonEntryClosure }
  from '@foreman-code/contracts/remote-execution-entry-closure-node'
import { recoverInstalledJobRuntimeQualifications } from '../jobs/index.js'
import { installedSourceQuotaPool } from '../jobs/index.js'
import { JOB_OUTPUT_NAMESPACE } from '../files/jobs/workerProtocol.js'
import { componentLogger } from '../diagnostics/index.js'
import { createWorkerSourceRsyncAcknowledgement } from '../sources/index.js'
import { createInstalledRsyncComposition, type InstalledRsyncProviders } from '../byte-transfer/productionComposition.js'
import { randomUUID } from 'node:crypto'
import { RemoteJobExecutionRpcRequestRecordSchema } from '@foreman-code/contracts/remote-job-execution'
import { createInstalledJobExecutionHost } from '../jobs/index.js'
import { createVerificationSystemInput } from '../jobs/index.js'
import { WorkerJobApplicationSink } from '../runs/index.js'
import { createInstalledJobSource } from '../runs/index.js'
import { createRemoteExecutionHandler, executionExtension } from '../runs/index.js'
import { workflowPreparationExtension } from '../runs/index.js'
import { REMOTE_EXECUTION_EXTENSION, REMOTE_PREPARATION_EXTENSION } from '@foreman-code/contracts/remote-execution-rpc'
import { createWorkerJobInputPort } from '../files/jobInputs/workerFactory.js'
import { JOB_INPUT_NAMESPACE } from '../files/jobInputs/protocol.js'
import { createWorkerJobOutputCollector } from '../runs/index.js'
import { createInstalledJobOutputRsync } from '../runs/index.js'
import { createInstalledJobInputRsync } from '../runs/index.js'
import { DeviceConnectionError } from './deviceWire.js'
import { sameDeviceInstallation } from './deviceReconnect.js'
import type { RemoteJobExecutionHost, RemoteJobExecutionHostPorts } from '../runs/index.js'
import { RemoteOperationJournal } from '../runs/index.js'
import { NativeProcessRegistry } from '../harnesses/recovery/processRegistry.js'
import { createWorkerQualificationExtension } from '../jobs/index.js'
import type { InstalledRuntimeConfigurationLocation } from '../jobs/installedRuntimeHost.js'
import { join } from 'node:path'
import { homedir } from 'node:os'
import { selectInstalledClaude } from '../computers/installedClaudeSelection.js'
import { selectInstalledCodex } from '../computers/installedCodexSelection.js'
import { isDeepStrictEqual } from 'node:util'
import type { WorkerPairingConfiguration } from '@foreman-code/contracts/device-identity'
import { ApprovedRootAllowlistSchema, type ApprovedRootAllowlist } from '@foreman-code/contracts/workspace-root-policies'
import { HarnessDiscoveryRequestSchema, HARNESS_PROFILE_CHECK_NAMESPACE } from '@foreman-code/contracts/harness-registry'
import { EXECUTION_AUTHORITY_EXTENSION } from '@foreman-code/contracts/execution-authority'
import {
  SOURCE_OPERATION_EXTENSION,
  SourceOperationResponseSchema,
  SourceTransferStatusResponseSchema,
} from '@foreman-code/contracts/source-operations'
import type { DeviceExtensionRegistration, DeviceExtensionContext } from './deviceApplicationChannel.js'
import type { DeviceConnectionSupervisor } from './connectionSupervisor.js'
import { MainClock } from './workerClock.js'
import { createAuthenticatedTransferReceiver, transferContextForBinding } from '../byte-transfer/carrier.js'
import { sourceTransfersOnMain } from '../sources/index.js'
import { SourceOperationWorkerService } from '../sources/index.js'
import { createInstalledWorkflowHost, type InstalledWorkflowHostOptions } from '../runs/index.js'
import { InstalledWorkflowRecovery } from '../runs/index.js'
import type { InstalledWorkflowConfigurationLocation } from '../runs/index.js'
import { inspectInstalledCodex } from '../harnesses/installedCodexInspection.js'
import { COMPUTER_MAINTENANCE_NAMESPACE, COMPUTER_MAINTENANCE_VERSION, MaintenanceReplySchema, MaintenanceRequestSchema } from '@foreman-code/contracts/computer-maintenance'
import { ComputerMaintenance, systemMaintenancePorts, type MaintenancePorts } from '../computers/maintenance.js'
import { COMPUTER_ACCOUNTS_NAMESPACE, COMPUTER_GITHUB_NAMESPACE, ComputerAccountsRequestSchema, GitHubLoginRequestSchema } from '@foreman-code/contracts/computer-accounts'
import { createComputerSyncExtension } from '../computers/syncExtension.js'
import { SyncthingComputer } from '../computers/syncthingComputer.js'
import { GitHubLoginRunner } from '../computers/githubLogin.js'
import {
  AGENT_SNAPSHOT_JSON_BYTES, AGENT_SNAPSHOT_NAMESPACE, AgentSnapshotRequestSchema, AgentSnapshotResultSchema,
} from '@foreman-code/contracts/source-materialization'
import { snapshotAgentWorktree } from '../sources/index.js'
import { CI_HOST_NAMESPACE, CI_RUNTIME_NAMESPACE } from '@foreman-code/contracts'
import { HostCiRunner, hostCiDirectory, systemHostCiPorts } from '../ci/runner.js'
import { CiRuntimeWorker, currentCiRuntimePaths, lastCiRuntimeRefresh, prepareCiRuntime, retainedCiJobImages,
  retireCiRuntimeConfigurations } from '../ci/runtime.js'
import { systemGitWorktreePorts } from '../sources/index.js'
import { readInstalledWorkflowConfiguration } from '../runs/index.js'
import { probeComputerAccounts, systemPorts } from '../computers/accountProbe.js'
import { inspectInstalledClaudeInventory } from '../harnesses/installedClaudeInspection.js'
import { createInstalledWorkerProfileChecks } from '../harnesses/installedWorkerProfileChecks.js'
import { DomainError } from '../errors.js'
import { jobContainerNonEntryObserved } from '../jobs/index.js'
import { proveOCIBoundaryEmpty } from '../jobs/index.js'
import { sourceMaterializationDigest } from '../sources/index.js'
import { createWorkerResourceTelemetryExtension } from '../resource-telemetry/index.js'
import { createLinuxResourceCollector } from '../resource-telemetry/index.js'
import { createInstalledWorkerConversations } from '../conversations/installedWorkerConversations.js'
import { WORKER_MCP_EXTENSION } from '@foreman-code/contracts/worker-mcp-relay'
import { WORKER_UPDATE_DRAIN_TIMEOUT_MS } from '@foreman-code/contracts/worker-update'

interface InstalledWorkerInput {
  stateDirectory: string
  launcherSource?: URL
  pairing: WorkerPairingConfiguration
  bootId: string
  /** The packaged Worker's existing exclusive state socket remains held during journal recovery. */
  assertStateOwnership?: () => void
  configuration: InstalledWorkflowConfigurationLocation | null
  refreshWorkflowConfiguration?: (signal: AbortSignal) => Promise<InstalledWorkflowConfigurationLocation | null>
  nativeOutputs?: InstalledWorkflowHostOptions['nativeOutputs']
  jobConfiguration?: InstalledRuntimeConfigurationLocation | null
  jobReports?: Pick<RemoteJobExecutionHostPorts, 'prepareOutputs' | 'preparePublication'>
  approvedRoots(): Promise<ApprovedRootAllowlist | null>
  connection(): (Pick<DeviceConnectionSupervisor, 'currentBinding' | 'captureRequest' | 'mainNow'>
    & Partial<Pick<DeviceConnectionSupervisor, 'linkLostAt'>>) | undefined
  codexSuiteRevision: string
  providerAccounts?: Omit<WorkerAccountOperationPorts, 'current'>
  /** Installed original source/output, canonical acknowledgement and stopped-writer ports. */
  rsync?: InstalledRsyncProviders
  workerUpdate?: NonNullable<MaintenancePorts['workerUpdate']>
  browserRuntime?: MaintenancePorts['browserRuntime']
  ciStartupPending?: () => boolean | Promise<boolean>
  assertBundleReady?(context: DeviceExtensionContext): Promise<void>
}

interface WorkerRequestActivity {
  namespace: string
  payload: unknown
  sourceCleanup: boolean
  waitingOnMain: number
}

type WorkerCurrentBinding = () => NonNullable<ReturnType<DeviceConnectionSupervisor['currentBinding']>>
type WorkerMainRequest = (
  namespace: string,
  payload: unknown,
  options?: { signal?: AbortSignal; bytes?: Uint8Array; timeoutMs?: number },
) => ReturnType<NonNullable<ReturnType<DeviceConnectionSupervisor['captureRequest']>>['request']>

/** What changes after the worker domains open: lazily opened journals and hosts, the selected configuration, activation. */
interface WorkerState {
  configuration: InstalledWorkflowConfigurationLocation | null
  maintenance: Promise<ComputerMaintenance> | undefined
  journalOpening: Promise<RemoteOperationJournal> | undefined
  jobJournalOpening: Promise<RemoteOperationJournal> | undefined
  nativeRecordCleanup: Promise<unknown> | undefined
  profileChecks: Awaited<ReturnType<typeof createInstalledWorkerProfileChecks>> | null
  providerAccounts: Omit<WorkerAccountOperationPorts, 'current'> | undefined
  accounts: ReturnType<typeof workerProviderAccountResolver> | undefined
  native: Awaited<ReturnType<typeof createInstalledWorkflowHost>> | undefined
  openWorkflow: ((location: InstalledWorkflowConfigurationLocation) => Promise<void>) | undefined
  jobs: RemoteJobExecutionHost | undefined
  jobOpening: Promise<RemoteJobExecutionHost> | undefined
  jobInputs: ReturnType<typeof createWorkerJobInputPort> | ReturnType<typeof createInstalledJobInputRsync> | undefined
  conversations: Awaited<ReturnType<typeof createInstalledWorkerConversations>> | null
  activation: Promise<void> | undefined
  shutdown: Promise<void> | undefined
}

/** Stages that an earlier stage's code reaches before the later stage has built them. */
interface WorkerForward {
  updateDrain: Late<ReturnType<typeof createWorkerRuntimeDrain>>
  activateWorkflowConfiguration: Late<(location: InstalledWorkflowConfigurationLocation) => Promise<void>>
}

type WorkerTransfers = Awaited<ReturnType<typeof createWorkerTransfers>>
type WorkerSources = Awaited<ReturnType<typeof createWorkerSources>>
type WorkerComputers = Awaited<ReturnType<typeof createWorkerComputers>>

/** Opens the installed worker domains under the paired Main connection. */
export async function createInstalledWorkerDomains(input: InstalledWorkerInput) {
  const state: WorkerState = {
    configuration: input.configuration,
    maintenance: undefined,
    journalOpening: undefined,
    jobJournalOpening: undefined,
    nativeRecordCleanup: undefined,
    profileChecks: null,
    providerAccounts: undefined,
    accounts: undefined,
    native: undefined,
    openWorkflow: undefined,
    jobs: undefined,
    jobOpening: undefined,
    jobInputs: undefined,
    conversations: null,
    activation: undefined,
    shutdown: undefined,
  }
  const forward: WorkerForward = {
    updateDrain: late('updateDrain'),
    activateWorkflowConfiguration: late('activateWorkflowConfiguration'),
  }
  const transfers = await createWorkerTransfers({ input, state, forward })
  const sources = await createWorkerSources({ input, state, transfers })
  const computers = await createWorkerComputers({ input, state, forward, transfers })
  const execution = await createWorkerExecution({ input, state, transfers })
  forward.activateWorkflowConfiguration.bind(execution.activateWorkflowConfiguration)
  const drain = await createWorkerDrain({ input, state, transfers, sources, computers })
  forward.updateDrain.bind(drain.updateDrain)
  const { lifetime, registry, journal, rsync, active } = transfers
  const { hostCi, ciRuntime, telemetry, qualification } = computers
  startNativeRecordCleanup(state, lifetime, registry, journal)
  return {
    extensions: drain.tracked,
    rsyncAvailable: rsync.kind === 'configured',
    rsyncMissing: rsync.missing,
    async drainForUpdate(signal?: AbortSignal) {
      await drain.updateDrain.run(signal)
    },
    resumeAfterUpdate() {
      drain.updateDrain.resume()
      state.jobs?.resumeAdmissions()
      hostCi.resumeAdmissions()
      ciRuntime.resumeAdmissions()
    },
    ...(rsync.kind === 'configured' ? { rsync: rsync.backend, rsyncWriters: rsync.rsyncWriters, rsyncOwnership: rsync.ownership } : {}),
    get workflowAvailable() { return state.native?.kind === 'configured' }, sourceAvailable: Boolean(sources.receiver),
    close() { return state.shutdown ??= (async () => {
      lifetime.abort()
      await Promise.allSettled([state.activation, state.nativeRecordCleanup])
      const failures: unknown[] = []
      try { registry.closeRetention() } catch (error) { failures.push(error) }
      try { await hostCi.beginDrain() } catch (error) { failures.push(error) }
      try { await ciRuntime.close() } catch (error) { failures.push(error) }
      try { await state.providerAccounts?.native.close() } catch (error) { failures.push(error) }
      try { await state.profileChecks?.close() } catch (error) { failures.push(error) }
      try { await telemetry.close() } catch (error) { failures.push(error) }
      try { if (rsync.kind === 'configured') await rsync.rsyncWriters.close() } catch (error) { failures.push(error) }
      try { if (state.jobOpening) await (await state.jobOpening).shutdown() } catch (error) { failures.push(error) }
      try { await state.jobInputs?.close() } catch (error) { failures.push(error) }
      try { if (state.native?.kind === 'configured') await state.native.close() } catch (error) { failures.push(error) }
      try { await state.conversations?.close() } catch (error) { failures.push(error) }
      await Promise.allSettled([...active.keys()])
      await qualification?.drain()
      try { await sources.receiver?.receiver.close() } catch (error) { failures.push(error) }
      if (!failures.length) {
        for (const opening of [state.journalOpening, state.jobJournalOpening]) {
          if (opening) { try { await (await opening).close() } catch (error) { failures.push(error) } }
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Actual installed worker domain cleanup is incomplete.')
    })() },
  }
}

function startNativeRecordCleanup(
  state: WorkerState,
  lifetime: AbortController,
  registry: NativeProcessRegistry,
  journal: () => Promise<RemoteOperationJournal>,
): void {
  const cleanup = () => {
    if (state.nativeRecordCleanup || lifetime.signal.aborted) return
    state.nativeRecordCleanup = (async () => {
      const openJournal = await journal()
      await registry.pruneSettled(owner => lifetime.signal.aborted
        ? Promise.resolve(false) : openJournal.isNativeOwnerSettled(owner))
    })().catch(error => {
      componentLogger('engine').warn({ err: error }, 'Native closure retention cleanup failed')
    }).finally(() => { state.nativeRecordCleanup = undefined })
  }
  const timer = setInterval(cleanup, 10 * 60_000)
  timer.unref()
  lifetime.signal.addEventListener('abort', () => clearInterval(timer), { once: true })
}

async function createWorkerTransfers({ input, state, forward }: {
  input: InstalledWorkerInput
  state: WorkerState
  forward: WorkerForward
}) {
  const lifetime = new AbortController()
  const configurationLocation = input.configuration ?? {
    path: join(input.stateDirectory, 'workflow-runtime.json'), ownerUid: process.getuid!(),
  }
  const active = new Map<Promise<unknown>, WorkerRequestActivity>()
  const requestActivity = new AsyncLocalStorage<WorkerRequestActivity>()
  const registry = new NativeProcessRegistry(join(input.stateDirectory, 'workflow-native-processes'))
  const jobRegistry = new NativeProcessRegistry(join(input.stateDirectory, 'job-runtime-native-processes'))
  const mainClock = new MainClock()
  const observedMainTime = () => {
    const observed = input.connection()?.mainNow()
    if (observed !== undefined) mainClock.observe(observed)
    return mainClock.observed ? mainClock.now() : undefined
  }
  const mainNow: () => number = () => {
    const now = observedMainTime()
    if (now === undefined) throw new DomainError('WORKER_CLOCK_UNTRUSTED',
      'Main clock has not been observed on this connection.', 409)
    return now
  }
  const ownership = { now: () => observedMainTime() ?? Date.now(),
    retentionNow: () => input.connection()?.mainNow(),
    ...(input.assertStateOwnership ? { assertExclusiveOwner: input.assertStateOwnership } : {}) }
  const jobJournal: () => Promise<RemoteOperationJournal> = () => state.jobJournalOpening ??= RemoteOperationJournal.open(
    join(input.stateDirectory, 'job-runtime-operations.json'), ownership)
  const systemInput = createVerificationSystemInput({ configuration: input.jobConfiguration ?? null, journal: jobJournal })
  const journal: () => Promise<RemoteOperationJournal> = () => state.journalOpening ??= RemoteOperationJournal.open(
    join(input.stateDirectory, 'workflow-operations.json'), ownership)
  const current: WorkerCurrentBinding = () => {
    lifetime.signal.throwIfAborted()
    const binding = input.connection()?.currentBinding()
    if (!binding || binding.mainId !== input.pairing.mainId || binding.deviceId !== input.pairing.deviceId
      || binding.workerInstallationId !== input.pairing.workerInstallationId || binding.bootId !== input.bootId
      || binding.keyRevision !== input.pairing.keyRevision || binding.authorizationRevision !== input.pairing.authorizationRevision)
      throw new DomainError('WORKER_DOMAIN_UNAVAILABLE', 'The current original paired Main connection is unavailable.', 409)
    return binding
  }
  const request: WorkerMainRequest = async (namespace: string, payload: unknown, options?: { signal?: AbortSignal; bytes?: Uint8Array; timeoutMs?: number }) => {
    const binding = current(), captured = input.connection()?.captureRequest(namespace)
    if (!captured || !isDeepStrictEqual(captured.binding, binding)) throw new DomainError('WORKER_DOMAIN_UNAVAILABLE', 'The exact original Main channel is unavailable.', 409)
    const activity = requestActivity.getStore()
    if (activity?.sourceCleanup) activity.waitingOnMain++
    let reply
    try {
      reply = await captured.request(payload, { ...options,
        signal: options?.signal ? AbortSignal.any([options.signal, lifetime.signal]) : lifetime.signal })
    } finally {
      if (activity?.sourceCleanup) activity.waitingOnMain--
    }
    if (activity?.sourceCleanup) forward.updateDrain.get().assertAdmission(activity.namespace, activity.payload)
    if (!isDeepStrictEqual(current(), binding)) throw new DomainError('WORKER_DOMAIN_UNAVAILABLE', 'The authenticated Main generation changed.', 409)
    return reply
  }
  const roots: () => Promise<ApprovedRootAllowlist> = async () => {
    lifetime.signal.throwIfAborted()
    const value = await input.approvedRoots()
    if (!value) throw new DomainError('ROOT_CONFIGURATION_MISSING', 'The actual human-approved worker roots are unavailable.', 409)
    return ApprovedRootAllowlistSchema.parse(value)
  }
  const approved: ApprovedRootAllowlist | null = await input.approvedRoots()
  const managedMcp = createInstalledWorkerManagedMcp({ stateDirectory: input.stateDirectory,
    configuration: configurationLocation, availableConfiguration: () => state.configuration,
    registry, launcherSource: input.launcherSource })
  if (approved) await managedMcp.ensureReady({ signal: lifetime.signal }).catch(error => {
    componentLogger('devices').warn({ operation: 'repair managed MCP mount', err: error }, 'Managed Foreman Code MCP setup needs repair')
  })
  state.profileChecks = approved ? await createInstalledWorkerProfileChecks({ stateDirectory: input.stateDirectory,
    configuration: state.configuration, pairing: input.pairing, current, registry,
    accounts: () => state.accounts }) : null
  let jobOutputRsync: Awaited<ReturnType<typeof createInstalledJobOutputRsync>> | undefined
  let jobInputRsync: ReturnType<typeof createInstalledJobInputRsync> | undefined
  const sourceAcknowledgement = input.rsync && createWorkerSourceRsyncAcknowledgement({
    authenticate: async (intent, context, signal) => {
      if (!isDeepStrictEqual(transferContextForBinding(current()), context)) throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Source acknowledgement requires the original current channel.', 409)
      signal.throwIfAborted(); await input.rsync!.accepted.authorize(intent, context, 'read'); signal.throwIfAborted()
      if (!isDeepStrictEqual(transferContextForBinding(current()), context)) throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Source acknowledgement generation changed.', 409)
    },
    currentCommitted: async (id, context, signal) => {
      if (!isDeepStrictEqual(transferContextForBinding(current()), context)) throw new DomainError('SOURCE_CONNECTION_CONFLICT', 'Source status requires the actual current Main capture.', 409)
      const reply = await request(SOURCE_OPERATION_EXTENSION.namespace, { version: 1, operation: 'sources.transfer-status', transferId: id }, { signal })
      const response = SourceTransferStatusResponseSchema.parse(reply.payload)
      if (reply.bytes !== undefined || response.operation !== 'sources.transfer-status' || response.intent.transferId !== id)
        throw new DomainError('SOURCE_TRANSFER_CONFLICT', 'Main did not return the original committed source record.', 403)
      return { intent: response.intent, record: response.record }
    },
    approvedRoots: roots,
  })
  const rsyncProviders: InstalledRsyncProviders | undefined = input.rsync ? { ...input.rsync,
    resolveSource:async(intent,signal)=>jobOutputRsync&&await jobOutputRsync.owns(intent)?jobOutputRsync.resolveSource(intent,signal):input.rsync!.resolveSource(intent,signal),
    acknowledged: async (intent, context) => {
    if (intent.byteClass === 'source' && intent.direction === 'to-worker') await sourceAcknowledgement!.acknowledged(intent, context)
    else if(jobOutputRsync&&await jobOutputRsync.owns(intent))await jobOutputRsync.acknowledged(intent,context)
    else if(jobInputRsync&&await jobInputRsync.owns(intent))await jobInputRsync.acknowledged(intent,context)
    else await input.rsync!.acknowledged(intent, context)
  } } : undefined
  const rsync = createInstalledRsyncComposition({ side: 'worker', providers: approved ? rsyncProviders : undefined,
    current: deviceId => deviceId === input.pairing.deviceId ? current() : undefined })
  if (rsync.kind === 'configured' && input.rsync && input.jobConfiguration && approved) jobOutputRsync = await createInstalledJobOutputRsync({
    providers: { ...input.rsync, quiescent: async (intent, signal) => { await rsync.writers.quiescent(intent, signal); await input.rsync!.quiescent(intent, signal) } },
    ownership: rsync.ownership, journal: await jobJournal(), current, request })
  if (rsync.kind === 'configured' && input.rsync && input.jobConfiguration && approved) jobInputRsync = createInstalledJobInputRsync({
    systemInput,
    receiver: input.rsync.receiver, journal: await jobJournal(), channel: { request, currentBinding: current },
    receiptRoot: join(input.stateDirectory, 'job-input-receipts'), admissionRoot: join(input.stateDirectory, 'job-input-rsync-admissions') })
  const extensions: DeviceExtensionRegistration[] = rsync.extensions.map(extension => ({ ...extension, role: 'duplex' as const }))
  return { lifetime, configurationLocation, active, requestActivity, registry, jobRegistry, mainNow, jobJournal, systemInput, journal, current, request, roots, approved, managedMcp, jobOutputRsync, jobInputRsync, rsync, extensions }
}

async function createWorkerSources({ input, state, transfers }: {
  input: InstalledWorkerInput
  state: WorkerState
  transfers: WorkerTransfers
}) {
  const { approved, configurationLocation, current, extensions, jobJournal, jobRegistry, journal, lifetime, mainNow, managedMcp, registry, request, roots, rsync } = transfers
  const providerAccounts = state.providerAccounts = input.providerAccounts ?? createInstalledWorkerAccounts({
    stateDirectory: input.stateDirectory, configuration: configurationLocation, current, registry,
    prepareAccount: account => managedMcp.ensureReady({ account, signal: lifetime.signal }),
    target: { hostRef: { kind: 'device', mainId: input.pairing.mainId, deviceId: input.pairing.deviceId },
      applicationInstallationId: input.pairing.workerInstallationId, keyRevision: input.pairing.keyRevision,
      authorizationRevision: input.pairing.authorizationRevision },
    request: (namespace, payload) => request(namespace, payload),
  })
  const accounts = state.accounts = providerAccounts
    ? workerProviderAccountResolver({ ...providerAccounts, current }) : undefined
  if (providerAccounts) {
    extensions.push(createProviderAccountWorkerExtension({ ...providerAccounts, current }))
  }
  let receiver: ReturnType<typeof createAuthenticatedTransferReceiver> | undefined
  if (approved) {
    receiver = createAuthenticatedTransferReceiver({ stagingRoot: join(input.stateDirectory, 'source-transfer-staging'),
      current: deviceId => { const binding = input.connection()?.currentBinding(); return binding?.deviceId === deviceId ? binding : undefined },
      accepted: rsync.kind === 'configured' ? input.rsync!.accepted : sourceTransfersOnMain(request, current),
      ...(rsync.kind === 'configured' ? { receiver: input.rsync!.receiver } : {}) })
    const sources = new SourceOperationWorkerService({
      mainNow: mainNow,
      authenticate: async context => {
        if (!sameDeviceInstallation(current(), context.binding)) {
          throw new DomainError('SOURCE_CONNECTION_CONFLICT',
            'Source operation belongs to a different Worker boot or installation.', 409)
        }
      },
      approvedRoots: roots,
      async quotaPoolFor(binding) {
        const pool = await installedSourceQuotaPool(input.jobConfiguration ?? null, binding)
        return pool ? { pool } : undefined
      },
      currentOwner: async (operation, context) => {
        const reply = await request(SOURCE_OPERATION_EXTENSION.namespace, { version: 1, operation: 'sources.authorize', request: operation }, { signal: context.signal })
        const value = SourceOperationResponseSchema.parse(reply.payload)
        if (reply.bytes !== undefined || value.operation !== 'sources.authorize') throw new DomainError('SOURCE_OPERATION_AUTHORITY_CONFLICT', 'The original Main did not return source operation authority.', 403)
        return value.owner
      },
      currentReclamation: async (reservationId, reclamationId, context) => {
        const reply = await request(SOURCE_OPERATION_EXTENSION.namespace, { version: 1,
          operation: 'sources.reclamation-authorize', reservationId, reclamationId }, { signal: context.signal })
        if (reply.bytes !== undefined) throw new DomainError('SOURCE_ROLE_DENIED', 'Cleanup authority contains no binary data.', 403)
        return SourceReservationReclamationAuthorityResponseSchema.parse(reply.payload).grant
      },
      reclamationNativeClosed: async (owner, operationId) => {
        const retained = await jobJournal()
        const status = await retained.jobStatus(operationId)
        if (status.status === 'known' && (!status.receipt.terminal?.processStopped
          || !['complete', 'failed'].includes(status.receipt.publication))) return false
        const jobOwner = await retained.jobNativeOwner(operationId)
        if (jobOwner) {
          if (jobOwner.connection.bootId !== input.bootId || status.status !== 'known' || !status.receipt.terminal?.processStopped
            || !['complete', 'failed'].includes(status.receipt.publication)
            || jobOwner.launches.some(launch => !launch.closed)) return false
          const certificate = jobOwner.container?.certificate
          if (!jobOwner.nonEntryConfirmed || !jobContainerNonEntryObserved(jobOwner)) {
            if (!certificate || certificate.lifecycle !== 'closed'
              || certificate.scope.subject.operationId !== operationId
              || certificate.scope.bootId !== input.bootId || !await proveOCIBoundaryEmpty(certificate.boundary)
              || !(await Promise.all(certificate.helpers.map(helper => helper.boundary
                ? proveOCIBoundaryEmpty(helper.boundary) : Promise.resolve(false)))).every(Boolean)) return false
          }
        }
        if (state.native?.kind === 'configured') {
          if (!owner) return state.native.reservationClosed(operationId)
          return state.native.preparationClosed({ ...owner, preparationKind: 'workflow', preparationClosed: true })
        }
        // Removing a runtime selection does not erase protected operation or process records.
        if ([...registry.snapshot().launches, ...jobRegistry.snapshot().launches]
          .some(launch => launch.lifecycle !== 'closed')) return false
        const workflow = await (await journal()).status(operationId)
        if (workflow.status === 'known') {
          return hasPositiveRemoteEntryClosure(workflow.receipt) || hasPositiveRemoteNonEntryClosure(workflow.receipt)
        }
        const recovery = new InstalledWorkflowRecovery(join(input.stateDirectory, 'workflow-recovery'), registry)
        return !recovery.hasCapture(operationId)
      },
      nativeOwnerFor: record => state.native?.kind === 'configured' ? state.native.nativeOwnerFor(record) : Promise.resolve(null),
      preparationNativeClosed: async (operationId, owner) => {
        if (owner.preparationKind === 'workflow') {
          return state.native?.kind === 'configured' ? state.native.preparationClosed(owner) : false
        }
        if (!input.jobConfiguration) return false
        const retained = await jobJournal(), nativeOwner = await retained.jobNativeOwner(operationId)
        if (!nativeOwner) return true
        const status = await retained.jobStatus(operationId)
        if (status.status !== 'known' || !status.receipt.terminal?.processStopped
          || !['complete', 'failed'].includes(status.receipt.publication) || !owner.record) return false
        const execution = status.receipt.execution, receipt = owner.record.receipt
        if (execution.id !== owner.attempt.executionId || execution.attemptId !== owner.attempt.attemptId
          || execution.operationId !== operationId || execution.workspaceId !== owner.root.binding.workspaceId
          || execution.acceptedSpec.source.materializationId !== receipt.materializationId
          || execution.acceptedSpec.source.materializationDigest !== sourceMaterializationDigest(owner.record)
          || execution.acceptedSpec.bindingHash !== owner.record.finalDispatchBindingHash
          || nativeOwner.connection.bootId !== input.bootId || nativeOwner.launches.some(launch => !launch.closed)) return false
        if (nativeOwner.nonEntryConfirmed && jobContainerNonEntryObserved(nativeOwner)) return true
        const certificate = nativeOwner.container?.certificate
        if (!certificate || certificate.lifecycle !== 'closed' || certificate.scope.subject.operationId !== operationId
          || certificate.scope.bootId !== input.bootId) return false
        return await proveOCIBoundaryEmpty(certificate.boundary)
          && (await Promise.all(certificate.helpers.map(helper => helper.boundary
            ? proveOCIBoundaryEmpty(helper.boundary) : Promise.resolve(false)))).every(Boolean)
      },
      preparationReconciled: async closure => {
        if (!input.jobConfiguration) return
        const retained = await jobJournal()
        const status = await retained.jobStatus(closure.operationId)
        if (status.status === 'known' && !await retained.isJobRetired(closure.operationId)) {
          await retained.jobSourceReclaimed(closure.operationId, closure)
        }
      },
      ...(rsync.kind === 'configured' ? {
        preparationTransfersClosed: (closure, signal) => rsync.backend.retirePreparation(closure, signal),
        executionTransfersClosed: (record, signal) => rsync.backend.retireMaterialization(record, signal),
      } : {}),
    })
    const createWorkflow = (location: InstalledWorkflowConfigurationLocation | null) =>
      createInstalledWorkflowHost({ stateDirectory: input.stateDirectory, mainNow: mainNow, pairing: input.pairing, bootId: input.bootId,
      configuration: location, currentBinding: () => input.connection()?.currentBinding(),
      linkLostAt: () => input.connection()?.linkLostAt?.(),
      captureRequest: namespace => input.connection()?.captureRequest(namespace), sources, approvedRoots: roots,
      ...(input.nativeOutputs ? { nativeOutputs: input.nativeOutputs } : {}),
      codexSuiteRevision: input.codexSuiteRevision,
      signal: lifetime.signal, registry, journal, ...(accounts ? { accounts } : {}) })
    state.native = await createWorkflow(state.configuration)
    state.openWorkflow = async location => {
      if (state.native?.kind !== 'configured') state.native = await createWorkflow(location)
    }
    extensions.push({ ...receiver.extension, role: 'duplex' }, { ...SOURCE_OPERATION_EXTENSION, role: 'duplex', async handle(payload, context) {
      return { payload: await sources.handle(payload, { ...context, signal: AbortSignal.any([context.signal, lifetime.signal]) }) }
    } }, ...(state.native.kind === 'configured' ? state.native.extensions : []))
  }
  if (input.jobConfiguration && approved) {
    await recoverInstalledJobRuntimeQualifications({ journal: await jobJournal(), registry: jobRegistry,
      host: { hostRef: { kind: 'device', mainId: input.pairing.mainId, deviceId: input.pairing.deviceId },
        registration: { workerInstallationId: input.pairing.workerInstallationId, keyRevision: input.pairing.keyRevision,
          authorizationRevision: input.pairing.authorizationRevision },
        mainInstallationId: input.pairing.mainId, bootId: input.bootId } })
  }
  return { receiver }
}

async function createWorkerComputers({ input, state, forward, transfers }: {
  input: InstalledWorkerInput
  state: WorkerState
  forward: WorkerForward
  transfers: WorkerTransfers
}) {
  const { approved, current, extensions, jobJournal, jobRegistry, lifetime, managedMcp, request, roots } = transfers
  extensions.push(createWorkerManagedMcpExtension(managedMcp.worker, current))
  const telemetry = createWorkerResourceTelemetryExtension({ signal: lifetime.signal, currentBinding: current,
    createCollector: (identity, signal) => createLinuxResourceCollector({ identity, signal,
      // The installed Job controller already reads host MemAvailable at native entry.
      wholeHostVisible: true,
      // This mount supplies computer metrics; no logical owner attribution is inferred.
      ownership: { async snapshot(signal) {
        signal.throwIfAborted()
        return { revision: jobRegistry.revision(), views: [] }
      }, changes: (revision, signal) => jobRegistry.changes(revision, signal) },
    }) })
  extensions.push(telemetry.extension)
  let qualification: ReturnType<typeof createWorkerQualificationExtension> | undefined
  if (input.jobConfiguration && approved) {
    qualification = createWorkerQualificationExtension({ configuration: input.jobConfiguration, pairing: input.pairing, bootId: input.bootId,
      currentBinding: current, now: () => {
        const now = input.connection()?.mainNow()
        if (now === undefined) throw new DomainError('WORKER_CLOCK_UNTRUSTED',
          'Main clock has not been observed on this connection.', 409)
        return now
      }, request,
      journal: jobJournal, registry: jobRegistry, signal: lifetime.signal })
    extensions.push(qualification)
  }
  const ciRuntime = new CiRuntimeWorker(input.stateDirectory, { git: systemGitWorktreePorts(hostEnvironment()),
    managedRuntimeRoot: async () => (await roots()).managedRuntimeRoot,
    prepare: async options => {
      const retained = await jobJournal()
      const qualifications = await retained.pendingQualifications()
      const used = [...options.keepImages ?? [],
        ...await retainedCiJobImages(retained),
        ...qualifications.map(receipt => receipt.candidate.fingerprint.imageDigest)]
      const configurations = await retireCiRuntimeConfigurations(input.stateDirectory, used)
      return prepareCiRuntime({ ...options, stateDirectory: input.stateDirectory, keepImages: [...used, ...configurations.images],
        keepPaths: [...options.keepPaths ?? [], ...configurations.paths] })
    },
    lastRefresh: lastCiRuntimeRefresh, currentRuntimePaths: currentCiRuntimePaths,
    now: () => new Date() }, lifetime.signal)
  extensions.push({ namespace: CI_RUNTIME_NAMESPACE, version: 1, role: 'server', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    async handle(payload, context) {
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) {
        throw new DomainError('CI_RUNTIME_STALE', 'CI runtime preparation requires the actual authenticated worker channel.', 409)
      }
      return { payload: await ciRuntime.handle(payload) }
    },
  })
  const hostCi = new HostCiRunner(hostCiDirectory(), systemHostCiPorts(), hostEnvironment(), input.ciStartupPending)
  extensions.push({ namespace: CI_HOST_NAMESPACE, version: 1, role: 'server', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    async handle(payload, context) {
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) {
        throw new DomainError('CI_HOST_STALE', 'Host CI requires the actual authenticated worker channel.', 409)
      }
      return { payload: await hostCi.handle(payload) }
    },
  })
  extensions.push({ namespace: COMPUTER_ACCOUNTS_NAMESPACE, version: 1, role: 'server', maxJsonBytes: 65_536, maxBinaryBytes: 0,
    async handle(payload, context) {
      const request = ComputerAccountsRequestSchema.parse(payload)
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) {
        throw new DomainError('COMPUTER_ACCOUNTS_STALE', 'Account facts require the actual authenticated worker channel.', 409)
      }
      const selected = await readInstalledWorkflowConfiguration(state.configuration)
      const binaries = { ...(selected?.codexBinary ? { codex: selected.codexBinary } : {}),
        ...(selected?.claude ? { claude: selected.claude.binary } : {}) }
      return { payload: await probeComputerAccounts(systemPorts(hostEnvironment(), binaries),
        AbortSignal.any([context.signal, lifetime.signal, AbortSignal.timeout(20_000)]),
        { refresh: request.refresh === true }) }
    },
  })
  extensions.push({ namespace: COMPUTER_MAINTENANCE_NAMESPACE, version: COMPUTER_MAINTENANCE_VERSION, role: 'server', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    async handle(payload, context) {
      const request = MaintenanceRequestSchema.parse(payload)
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) {
        throw new DomainError('COMPUTER_MAINTENANCE_STALE', 'Computer maintenance requires the actual authenticated worker channel.', 409)
      }
      // Main's bundle check before Start and Worker admission needs only the updater state, never the slow full inspection.
      if (request.operation === 'status' && request.scope === 'worker') {
        return { payload: MaintenanceReplySchema.parse({ operation: 'worker', worker: await input.workerUpdate?.status() ?? null }) }
      }
      state.maintenance ??= readInstalledWorkflowConfiguration(state.configuration)
        .then(selected => {
        // Maintenance reads the binaries this Worker actually runs; updates move each harness selection with them.
        const binaries: Record<string, string> = { ...(selected?.codexBinary ? { codex: selected.codexBinary } : {}),
          ...(selected?.claude ? { claude: selected.claude.binary } : {}) }
        return new ComputerMaintenance({ ...systemMaintenancePorts(hostEnvironment(), binaries),
          ...(input.browserRuntime ? { browserRuntime: input.browserRuntime } : {}),
          ...(input.workerUpdate ? { workerUpdate: input.workerUpdate } : {}),
          async selectInstalledCodex(signal) {
            const binary = await selectInstalledCodex(state.configuration, hostEnvironment().HOME ?? homedir(), signal)
            if (binary) binaries.codex = binary
            return binary
          },
          async selectInstalledClaude(signal) {
            const binary = await selectInstalledClaude(state.configuration, hostEnvironment(), signal)
            if (binary) binaries.claude = binary
            return binary
          } })
      })
      const owner = await state.maintenance
      return { payload: MaintenanceReplySchema.parse(request.operation === 'status'
        ? { operation: 'status', status: await owner.status(AbortSignal.any([context.signal, lifetime.signal, AbortSignal.timeout(90_000)])) }
        : { operation: 'start', task: await owner.start(request.task, request.commandId) }) }
    },
  })
  extensions.push({ namespace: AGENT_SNAPSHOT_NAMESPACE, version: 1, role: 'server', maxJsonBytes: AGENT_SNAPSHOT_JSON_BYTES, maxBinaryBytes: 0,
    async handle(payload, context) {
      const request = AgentSnapshotRequestSchema.parse(payload)
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) {
        throw new DomainError('AGENT_SNAPSHOT_STALE', 'Agent snapshots require the actual authenticated worker channel.', 409)
      }
      // Only an app-managed Agent worktree under this computer's approved roots can be read.
      const allowed = await roots()
      const path = await realpath(request.path)
      if (!path.endsWith('/tree') || ![allowed.managedRuntimeRoot, ...allowed.bases.map(base => base.canonicalPath)]
        .some(base => path.startsWith(`${base.replace(/\/$/u, '')}/`))) {
        throw new DomainError('AGENT_SNAPSHOT_DENIED', 'This folder is not an Agent worktree on this computer.', 403)
      }
      const snapshot = await snapshotAgentWorktree(systemGitWorktreePorts(hostEnvironment()), { path, baseCommit: request.baseCommit },
        AbortSignal.any([context.signal, lifetime.signal, AbortSignal.timeout(120_000)]))
      return { payload: AgentSnapshotResultSchema.parse({ commit: snapshot.commit, bundleBase64: snapshot.bundle?.toString('base64') ?? null }) }
    },
  })
  const sync = new SyncthingComputer()
  extensions.push(createComputerSyncExtension(sync, current))
  const githubLogin = new GitHubLoginRunner()
  lifetime.signal.addEventListener('abort', () => githubLogin.close(), { once: true })
  extensions.push({ namespace: COMPUTER_GITHUB_NAMESPACE, version: 1, role: 'server', maxJsonBytes: 16_384, maxBinaryBytes: 0,
    async handle(payload, context) {
      const request = GitHubLoginRequestSchema.parse(payload)
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) {
        throw new DomainError('COMPUTER_GITHUB_STALE', 'GitHub sign-in requires the actual authenticated worker channel.', 409)
      }
      return { payload: await githubLogin.handle(request) }
    },
  })
  extensions.push({ namespace: 'harness-discovery-v1', version: 1, role: 'server', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    async handle(payload, context) {
      HarnessDiscoveryRequestSchema.parse(payload)
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) throw new DomainError('HARNESS_INVENTORY_STALE', 'The actual installed inventory requires its original worker channel.', 409)
      const signal = AbortSignal.any([context.signal, lifetime.signal])
      const refreshed = input.refreshWorkflowConfiguration
        ? await input.refreshWorkflowConfiguration(signal) : input.configuration
      if (!isDeepStrictEqual(current(), context.binding)) throw new DomainError('HARNESS_INVENTORY_STALE', 'The installed inventory generation changed.', 409)
      if (!isDeepStrictEqual(current(), context.binding)) throw new DomainError('HARNESS_INVENTORY_STALE', 'The installed inventory generation changed.', 409)
      const inspected = await inspectInstalledCodex({ binding: context.binding, configuration: refreshed,
        fingerprintCache: inventoryPayloadFingerprints, environment: hostEnvironment(), cwd: input.stateDirectory,
        signal: AbortSignal.any([context.signal, lifetime.signal]) })
      const claude = await inspectInstalledClaudeInventory({ binding: context.binding, configuration: refreshed,
        fingerprintCache: inventoryPayloadFingerprints, environment: hostEnvironment(), cwd: input.stateDirectory,
        signal: AbortSignal.any([context.signal, lifetime.signal]) })
      if (!isDeepStrictEqual(current(), context.binding)) throw new DomainError('HARNESS_INVENTORY_STALE', 'The installed inventory generation changed.', 409)
      const installations = [...inspected.inventory.installations, ...claude.inventory.installations]
      if (refreshed && approved) {
        try {
          await forward.activateWorkflowConfiguration.get()(refreshed)
        } catch (error) {
          // Setup needs the selected payload; an unavailable one is reported below instead of hiding the inventory.
          if (installations.every(installation => installation.installed)) throw error
          componentLogger('devices').warn({ err: error }, 'Workflow activation waits for an unavailable installation')
        }
        if (!isDeepStrictEqual(current(), context.binding)) throw new DomainError('HARNESS_INVENTORY_STALE', 'The installed inventory generation changed.', 409)
      }
      return { payload: { ...inspected.inventory, installations } }
    },
  })
  return { qualification, telemetry, ciRuntime, hostCi }
}

async function createWorkerExecution({ input, state, transfers }: {
  input: InstalledWorkerInput
  state: WorkerState
  transfers: WorkerTransfers
}) {
  const { approved, configurationLocation, current, extensions, jobInputRsync, jobJournal, jobOutputRsync, jobRegistry, journal, lifetime, registry, request, roots, systemInput } = transfers
  const { accounts } = state
  const openJobs = () => state.jobOpening ??= (async () => {
    const connection = current(), retained = await jobJournal()
    const application = new WorkerJobApplicationSink({ request })
    state.jobInputs = jobInputRsync ?? createWorkerJobInputPort({ channel: { request, currentBinding: current },
      systemInput,
      stagingRoot: join(input.stateDirectory, 'job-input-transfer-staging'), receiptRoot: join(input.stateDirectory, 'job-input-receipts') })
    const host = createInstalledJobExecutionHost({ configuration: input.jobConfiguration ?? null, registry: jobRegistry,
      ...input.jobReports,
      connection, incarnationId: randomUUID(), journal: retained, currentBinding: current,
      source: createInstalledJobSource({ journal: retained, application, currentBinding: current, approvedRoots: roots }), inputs: state.jobInputs,
      authorize: (intent, _execution, action) => application.authorize(intent, action),
      observeReceipt: receipt => application.observeReceipt(receipt),
      appendLog: async chunk => {
        const owners = (await retained.jobOperations()).filter(receipt => receipt.execution.id === chunk.executionId && receipt.intent.attemptId === chunk.attemptId)
        if (owners.length !== 1) throw new DomainError('JOB_LOG_OWNER_UNAVAILABLE', 'The original Job log owner is unavailable.', 409)
        await application.appendLog(owners[0]!.intent, chunk)
      },
      collectOutputs: createWorkerJobOutputCollector({ request }, { current: async signal => { signal?.throwIfAborted(); return transferContextForBinding(current()) },
        retryable: error => error instanceof DeviceConnectionError && ['transport', 'timeout'].includes(error.code) }, retained,jobOutputRsync?.collector),
    })
    try { await host.recover() } catch (error) {
      componentLogger('jobs').error({ err: error }, 'Installed Job recovery failed')
      throw error
    }
    state.jobs = host
    return host
  })()
  const execution = extensions.find(extension => extension.namespace === REMOTE_EXECUTION_EXTENSION)
  const createConversations = () => createInstalledWorkerConversations({ stateDirectory: input.stateDirectory,
    configuration: state.configuration, registry, journal, approvedRoots: roots, current,
    capture: () => input.connection()?.captureRequest(REMOTE_EXECUTION_EXTENSION), request,
    codexSuiteRevision: input.codexSuiteRevision, signal: lifetime.signal, ...(accounts ? { accounts } : {}) })
  state.conversations = approved ? await createConversations() : null
  const activateWorkflowConfiguration: (location: InstalledWorkflowConfigurationLocation) => Promise<void> = async (location: InstalledWorkflowConfigurationLocation) => {
    if (!isDeepStrictEqual(location, configurationLocation)) {
      throw new DomainError('HARNESS_INVENTORY_STALE', 'The protected workflow selection location changed.', 409)
    }
    state.activation ??= (async () => {
      await readInstalledWorkflowConfiguration(location)
      lifetime.signal.throwIfAborted()
      state.configuration = location
      await state.openWorkflow?.(location)
      state.profileChecks ??= await createInstalledWorkerProfileChecks({ stateDirectory: input.stateDirectory,
        configuration: state.configuration, pairing: input.pairing, current, registry,
        accounts: () => state.accounts })
      state.conversations ??= await createConversations()
    })()
    try { await state.activation }
    finally { state.activation = undefined }
  }
  const workflowSupport = Boolean(approved && input.refreshWorkflowConfiguration)
  if ((state.conversations || workflowSupport) && !extensions.some(extension => extension.namespace === WORKER_MCP_EXTENSION.namespace)) {
    extensions.push({ ...WORKER_MCP_EXTENSION, role: 'client' })
  }
  if (workflowSupport && !extensions.some(extension => extension.namespace === EXECUTION_AUTHORITY_EXTENSION.namespace)) {
    extensions.push({ ...EXECUTION_AUTHORITY_EXTENSION, role: 'client' })
  }
  if (input.jobConfiguration && approved) {
    const outputExtension = extensions.find(extension => extension.namespace === JOB_OUTPUT_NAMESPACE)
    if (outputExtension) {
      if (outputExtension.role === 'server') outputExtension.role = 'duplex'
    } else {
      extensions.push({ namespace: JOB_OUTPUT_NAMESPACE, version: 1, role: 'client', maxJsonBytes: 16384, maxBinaryBytes: 8192 })
    }
    extensions.push({namespace:JOB_INPUT_NAMESPACE,version:1,role:'client',maxJsonBytes:1_048_576,maxBinaryBytes:8192})
  }
  if (input.jobConfiguration && approved || state.conversations || workflowSupport) {
    const handler = executionExtension({
      admit(_payload, context) {
        if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) throw new DomainError('JOB_RUNTIME_CONNECTION_CHANGED', 'Execution requires its actual authenticated worker channel.', 409)
      },
      async dispatch(payload, context) {
        const job = input.jobConfiguration && RemoteJobExecutionRpcRequestRecordSchema.safeParse(payload).success ? await openJobs() : state.jobs
        const conversationHost = state.conversations
        return { payload: await createRemoteExecutionHandler({ handle: async raw => {
          const workflow = state.native?.kind === 'configured'
            ? state.native.extensions.find(extension => extension.namespace === REMOTE_EXECUTION_EXTENSION)?.handle : undefined
          if (!workflow) throw new DomainError('WORKER_WORKFLOW_UNAVAILABLE', 'The installed Workflow runtime is unavailable.', 409)
          return (await workflow(raw, context)).payload
        } }, job, conversationHost ? { handle: raw => conversationHost.handle(raw, context.binding, context.signal) } : undefined)(payload) }
      },
    })
    if (execution) extensions.splice(extensions.indexOf(execution), 1, handler)
    else extensions.push(handler)
    const preparation = extensions.find(extension => extension.namespace === REMOTE_PREPARATION_EXTENSION.namespace)
    const preparationHandler = workflowPreparationExtension(handler)
    if (preparation) extensions.splice(extensions.indexOf(preparation), 1, preparationHandler)
    else if (workflowSupport) extensions.push(preparationHandler)
  }
  if (state.profileChecks || workflowSupport) extensions.push({
    namespace: HARNESS_PROFILE_CHECK_NAMESPACE, version: 1, role: 'server', maxJsonBytes: 1_048_576, maxBinaryBytes: 0,
    async handle(payload, context) {
      if (context.bytes !== undefined || !isDeepStrictEqual(current(), context.binding)) {
        throw new DomainError('HARNESS_INVENTORY_STALE', 'Profile checks require the authenticated worker channel.', 409)
      }
      if (!state.profileChecks) throw new DomainError('WORKER_WORKFLOW_UNAVAILABLE', 'Install a workflow harness first.', 409)
      return state.profileChecks.extension.handle(payload, context)
    },
  })
  return { activateWorkflowConfiguration }
}

async function createWorkerDrain({ input, state, transfers, sources, computers }: {
  input: InstalledWorkerInput
  state: WorkerState
  transfers: WorkerTransfers
  sources: WorkerSources
  computers: WorkerComputers
}) {
  const { active, extensions, jobRegistry, lifetime, managedMcp, registry, requestActivity, rsync } = transfers
  const { receiver } = sources
  const { ciRuntime, hostCi, qualification } = computers
  const updateWaits = new Set<string>()
  const drainStage = async (stage: string, run: () => Promise<void>) => {
    updateWaits.add(stage)
    try { await run() }
    finally { updateWaits.delete(stage) }
  }
  const updateDrain = createWorkerRuntimeDrain({ signal: lifetime.signal,
    waitingOn: () => [...updateWaits, ...new Set([...active.values()]
      .filter(task => task.namespace !== COMPUTER_MAINTENANCE_NAMESPACE && !(task.sourceCleanup && task.waitingOnMain))
      .map(task => task.namespace))],
    dispatches: () => [...active].filter(([, task]) => task.namespace !== COMPUTER_MAINTENANCE_NAMESPACE && !task.sourceCleanup)
      .map(([task]) => task),
    // Cleanup waits on Main in the background; its local work still participates in the final drain.
    active: () => [...active].filter(([, task]) => task.namespace !== COMPUTER_MAINTENANCE_NAMESPACE
      && !(task.sourceCleanup && task.waitingOnMain))
      .map(([task]) => task),
    drainJobs: async signal => {
      await Promise.all([
        drainStage('host-ci-preparation', () => hostCi.beginDrain()),
        drainStage('ci-runtime-preparation', () => ciRuntime.beginDrain()),
      ])
      signal.throwIfAborted()
      if (state.jobOpening) {
        const opening = state.jobOpening
        await drainStage('jobs', async () => {
          const jobs = await opening
          signal.throwIfAborted()
          await jobs.beginDrain()
        })
      }
      signal.throwIfAborted()
      if (state.native?.kind === 'configured') {
        const workflow = state.native
        await drainStage('workflow-turns', () => workflow.drainForUpdate())
      }
      signal.throwIfAborted()
      if (state.conversations) {
        const conversationHost = state.conversations
        await drainStage('conversation-tasks', () => conversationHost.drainForUpdate())
      }
    },
    drainQualifications: async () => { await qualification?.drain() },
    drainMaintenance: async () => { if (state.maintenance) await (await state.maintenance).drainForWorkerUpdate() },
    quiescent: async signal => {
      updateWaits.clear()
      if (!hostCi.isUpdateIdle()) {
        updateWaits.add('host-ci-preparation')
        return false
      }
      if (!ciRuntime.isUpdateIdle()) {
        updateWaits.add('ci-runtime-preparation')
        return false
      }
      const workflowLaunches = registry.snapshot().launches
      const jobLaunches = jobRegistry.snapshot().launches
      for (const [name, opening, launches] of [
        ['workflow-journal', state.journalOpening, workflowLaunches],
        ['job-journal', state.jobJournalOpening, jobLaunches],
      ] as const) {
        updateWaits.add(name)
        const log = await opening
        if (log && !await log.isWorkerUpdateIdle(launches)) return false
        updateWaits.delete(name)
      }
      const nativeActive = [...workflowLaunches, ...jobLaunches].some(launch =>
        launch.lifecycle !== 'closed' && !launch.owner.startsWith('conversation:'))
      if (nativeActive) {
        updateWaits.add('native-processes')
        return false
      }
      if (receiver) {
        updateWaits.add('byte-transfer-receiver')
        if (!await receiver.receiver.isWorkerUpdateIdle(intent => stoppedWorkerTransfer(state, transfers, input.stateDirectory, intent))) return false
        updateWaits.delete('byte-transfer-receiver')
      }
      if (rsync.kind === 'configured') {
        updateWaits.add('rsync-writers')
        const transfers = await Promise.allSettled(rsync.ownership.inventory().map(intent =>
          rsync.ownership.quiescent(intent, signal)))
        if (transfers.some(result => result.status === 'rejected')) return false
        updateWaits.delete('rsync-writers')
      }
      return true
    } })
  const tracked: DeviceExtensionRegistration[] = extensions.map(extension => ({ ...extension, ...(extension.handle ? { handle: (payload: unknown, context: DeviceExtensionContext) => {
    lifetime.signal.throwIfAborted()
    const activity = { namespace: extension.namespace, payload,
      sourceCleanup: isWorkerSourceCleanup(extension.namespace, payload), waitingOnMain: 0 }
    const task = requestActivity.run(activity, async () => {
      // Admission is decided when the request arrives, so a drain that starts during the bundle check waits for this task.
      updateDrain.assertAdmission(extension.namespace, payload)
      if (requiresWorkerBundle(extension.namespace, payload)) await input.assertBundleReady?.(context)
      if (extension.namespace === REMOTE_EXECUTION_EXTENSION && payload && typeof payload === 'object'
        && 'method' in payload && ['inspect-mcp', 'conversation.inspect-mcp'].includes(String(payload.method))) {
        await managedMcp.ensureReady({ signal: AbortSignal.any([context.signal, lifetime.signal,
          ...(context.connectionSignal ? [context.connectionSignal] : [])]) })
      }
      return extension.handle!(payload, { ...context, signal: AbortSignal.any([context.signal, lifetime.signal]) })
    })
    active.set(task, activity)
    void task.then(() => active.delete(task), () => active.delete(task))
    return task
  } } : {}) }))
  return { updateDrain, tracked }
}

async function stoppedWorkerTransfer(
  state: WorkerState,
  transfers: Pick<WorkerTransfers, 'journal' | 'jobJournal'>,
  stateDirectory: string,
  transfer: TransferIntent,
): Promise<boolean> {
  const journals = [
    ['workflow-operations.json', state.journalOpening, transfers.journal],
    ['job-runtime-operations.json', state.jobJournalOpening, transfers.jobJournal],
  ] as const
  for (const [file, opening, open] of journals) {
    if (!opening) {
      try { await stat(join(stateDirectory, file)) } catch (error) {
        if ((error as NodeJS.ErrnoException).code === 'ENOENT') continue
        throw error
      }
    }
    const journal = await (opening ?? open())
    const statuses = await Promise.all([journal.status(transfer.operationId), journal.jobStatus(transfer.operationId)])
    if (statuses.some(status => status.status === 'known' && status.receipt.stopFence
      && status.receipt.intent.mainId === transfer.mainId
      && status.receipt.intent.executionId === transfer.executionId
      && status.receipt.intent.attemptId === transfer.attemptId)) return true
  }
  return false
}

export function createWorkerRuntimeDrain(ports: {
  signal: AbortSignal
  active(): Promise<unknown>[]
  dispatches?(): Promise<unknown>[]
  drainJobs(signal: AbortSignal): Promise<void>
  drainQualifications(): Promise<void>
  drainMaintenance(): Promise<void>
  quiescent(signal: AbortSignal): Promise<boolean>
  waitingOn?(): string[]
}) {
  let draining = false
  let cleanupPaused = false
  let attempt: AbortController | undefined
  return {
    async run(requestSignal?: AbortSignal) {
      const controller = new AbortController()
      attempt = controller
      const signal = AbortSignal.any([ports.signal, controller.signal, ...(requestSignal ? [requestSignal] : [])])
      draining = true
      const startedAt = Date.now()
      let stage = 'dispatches'
      const diagnostics = setInterval(() => {
        componentLogger('devices').warn({ stage, elapsedMs: Date.now() - startedAt,
          waitingOn: ports.waitingOn?.() ?? [] }, 'Worker runtime update is still draining')
      }, 30_000)
      diagnostics.unref()
      const deadline = setTimeout(() => controller.abort(new DomainError('WORKER_UPDATE_DRAIN_DEADLINE_EXCEEDED',
        `Worker update drain exceeded ${WORKER_UPDATE_DRAIN_TIMEOUT_MS} ms while waiting for ${stage}.`, 503)),
      WORKER_UPDATE_DRAIN_TIMEOUT_MS)
      let abort!: () => void
      const aborted = new Promise<never>((_resolve, reject) => {
        abort = () => reject(signal.reason)
        signal.addEventListener('abort', abort, { once: true })
      })
      const runStage = async <T>(operation: () => Promise<T>): Promise<T> => {
        signal.throwIfAborted()
        const result = await Promise.race([operation(), aborted])
        signal.throwIfAborted()
        return result
      }
      try {
        // In-flight dispatches finish admission before the Job host stops accepting work.
        await runStage(() => Promise.allSettled(ports.dispatches?.() ?? ports.active()))
        stage = 'jobs'
        await runStage(() => ports.drainJobs(signal))
        stage = 'qualifications'
        await runStage(() => ports.drainQualifications())
        stage = 'maintenance'
        await runStage(() => ports.drainMaintenance())
        stage = 'quiescence'
        while (true) {
          const idle = await runStage(() => ports.quiescent(signal))
          // Keep cleanup available until it has closed native processes and transfers.
          if (idle) cleanupPaused = true
          if (idle && ports.active().length === 0) break
          await runStage(() => wait(100, undefined, { signal }))
        }
        signal.throwIfAborted()
      } catch (error) {
        draining = false
        cleanupPaused = false
        throw error
      } finally {
        clearInterval(diagnostics)
        clearTimeout(deadline)
        signal.removeEventListener('abort', abort)
        if (attempt === controller) attempt = undefined
      }
    },
    resume() {
      attempt?.abort(new DomainError('WORKER_UPDATE_DRAIN_ABANDONED', 'Worker update drain was abandoned.', 409))
      draining = false
      cleanupPaused = false
    },
    isDraining() { return draining },
    assertAdmission(namespace: string, payload: unknown) {
      if (draining && (isWorkerAdmission(namespace, payload)
        || cleanupPaused && isWorkerSourceCleanup(namespace, payload))) {
        throw new DomainError('WORKER_RUNTIME_DRAINING',
          'This computer is waiting for active work to finish before updating its runtime.', 409)
      }
    },
  }
}

function isWorkerSourceCleanup(namespace: string, payload: unknown): boolean {
  return namespace === SOURCE_OPERATION_EXTENSION.namespace && payload !== null && typeof payload === 'object'
    && 'operation' in payload && [
      'sources.reclaim-reservation', 'sources.reconcile-preparation', 'sources.release',
    ].includes(String(payload.operation))
}

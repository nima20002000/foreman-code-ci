import { assertActiveHarnessConfiguration, retiredHarnessError } from '../harnesses/index.js'
import { isRestartCancellation } from './executionPredicates.js'
import { inspectNativeResponse } from '../harnesses/responseAvailability.js'
import type { InteractionActivityEvidence } from './activityProjection.js'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { type DurableInteraction, type HarnessExecution, type AgentConfigurationVersion, type NativeSessionReference, type PendingNativeInteraction, type WorkflowRun } from '@foreman-code/contracts'
import { remainingCredentialLifetime } from '../access/credentialLifetime.js'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE, WORKER_CREDENTIAL_RENEWAL_WINDOW_MS, type IssuedWorkerCredential } from '../access/workerCredentials.js'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import { DomainError } from '../errors.js'
import type { WorkflowQueuedInput } from '../collaboration/index.js'
import { appendWorkflowChatInput } from './workflowChatInput.js'
import { nativePersistenceRedactor } from './nativePersistence.js'
import { coordinateSessionManager, isLeaseLost, type SingleWriterSessionManager } from './sessionWriter.js'
import { HarnessExecutionError } from '../harnesses/errors.js'
import { isTransientRefreshFailure, renewOwnedLeases } from '../leases/ownerLeases.js'
import { componentLogger } from '../diagnostics/logger.js'
import { isTransientExecutionError } from '../runs/executionRetryPolicy.js'
import type { RunOwnership } from '../runs/index.js'
import type { AttachedInteractionSession, NativeManagerResolutionContext, NativeManagerOwnershipContext, ResolvedNativeSessionManager } from './runtimePorts.js'
import { readDetachedWorkflowLifetime, readDetachedWorkflowSession, readRemoteWorkflowContinuation } from './workflowClosure.js'
import { assertSavedPendingApprovalOriginalLocked } from './nativeApprovalProof.js'
import { openWorkflowLifecycleLocked } from '../runs/repeatLifecycle.js'
import { workflowExecutionRequest } from '../runs/workflowExecutionRequest.js'
import { readWorkflowTeam } from '../runs/workflowTeamPrompt.js'
import { repeatTickIndex } from '../runs/repeatResolution.js'
import { reviewPreflightIdentity } from './reviewPolicy.js'
import { assertSameRepeatExecution } from './repeatObservation.js'
import { isRunInProgress } from '../runs/runState.js'
import type { ExecutionSessionHost, OwnedNativeSession } from './executionSessionHost.js'

/** Native dispatch never began, so the original request must still be pending natively. */
function nativeDispatchNotStarted(interaction: DurableInteraction): boolean {
  return ['not_started', 'pending', 'failed'].includes(interaction.deliveryState)
}

/** Exact native attachment, restart recovery and workflow credential preparation. */
export class ExecutionSessionAttachment {
  private readonly writers = new WeakMap<NativeHarnessSessionManager, SingleWriterSessionManager>()
  constructor(private readonly host: ExecutionSessionHost) {}

  detachedWorkflowSession(owner: RunOwnership,
    execution: HarnessExecution): Promise<NativeSessionReference | undefined> {
    if (this.host.workflowClosures?.recoverDetached) return this.host.workflowClosures.recoverDetached(owner, execution)
    return readDetachedWorkflowSession(owner, execution)
  }

  async waitForRestartWriter(owner: RunOwnership, execution: HarnessExecution,
    session: NativeSessionReference, correlationId: string, readLifetime: () => Promise<unknown>, signal?: AbortSignal) {
    owner.assertOwned()
    signal?.throwIfAborted()
    const lane = await this.host.interactions.coordination.getLane(session.harness, session.nativeSessionId)
    if (!lane?.leaseToken || !lane.leaseExpiresAt || Date.parse(lane.leaseExpiresAt) <= Date.now()) return
    const expiresAt = Date.parse(lane.leaseExpiresAt)
    const conflict = () => new DomainError('SESSION_LANE_BUSY',
      'The original native writer changed during restart recovery.', 409)
    const control = lane.correlationId && /^(?:control|close|attach)-/.test(lane.correlationId)
    if (lane.ownerAgentId !== execution.agentId || lane.leaseOwner !== execution.agentId
      || lane.correlationId && !control && lane.correlationId !== correlationId
      || expiresAt - Date.now() > 30_000) throw conflict()
    const lifetime = await readLifetime()
    if (!lifetime) throw conflict()
    for (;;) {
      owner.assertOwned()
      signal?.throwIfAborted()
      if (this.host.closing) throw new DomainError('ENGINE_RESTART',
        'The native session recovery is stopping for application restart.', 409)
      const currentLifetime = await readLifetime()
      const currentLane = await this.host.interactions.coordination.getLane(session.harness, session.nativeSessionId)
      owner.assertOwned()
      if (!isDeepStrictEqual(currentLifetime, lifetime) || !isDeepStrictEqual(currentLane, lane)) throw conflict()
      const remaining = expiresAt - Date.now()
      if (remaining <= 0) return
      await delay(Math.min(100, remaining), undefined, { signal })
    }
  }

  /** Restore a detached Main session before source verification requires its writer. */
  private async restoreSourceSession(owner: RunOwnership, execution: HarnessExecution): Promise<void> {
    if (!execution.nativeSessionId || !['running', 'waiting'].includes(execution.state)) return
    const session = await this.detachedWorkflowSession(owner, execution)
    if (!session) return
    const configuration = await this.host.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    if (!configuration) throw new DomainError('AGENT_CONFIGURATION_NOT_FOUND',
      'The accepted Agent configuration is unavailable.', 409)
    const context = await this.managerContext(execution, configuration)
    if (context.acceptedPlacement?.hostRef.kind !== 'main') return
    const resolved = this.resolveManager(context, owner)
    // Detect a lost process before reserving another attachment lifetime.
    if (context.harness === 'codex' && resolved.manager.originalEnvironment
      && !await resolved.manager.originalEnvironment(session)) {
      resolved.markFailed?.()
      await resolved.manager.dispose()
      this.host.managers.release?.(context, this.host.rawManagers.get(resolved.manager) ?? resolved.manager, 'failed')
      await this.host.cancellation.restartInterrupted(owner, execution)
      throw new HarnessExecutionError('EXECUTION_INTERRUPTED',
        'The original workflow native process is no longer available.', true)
    }
    try {
      await this.attachSession(context, session, { restartOwner: owner })
    } catch (error) {
      if (error instanceof HarnessExecutionError && error.result.error?.code === 'EXECUTION_INTERRUPTED') {
        await this.host.cancellation.restartInterrupted(owner, execution)
      }
      throw error
    }
    owner.assertOwned()
  }

  /** Revalidate source under the resident session's writer lease between turns. */
  async withSourceObservationLane<T>(owner: RunOwnership, execution: HarnessExecution, work: () => Promise<T>): Promise<T> {
    owner.assertOwned()
    if (owner.runId !== execution.runId) throw new DomainError('RUN_OWNERSHIP_LOST', 'Source observation requires its original Run owner.', 409)
    if (!this.host.ownedSessions.has(execution.id)) await this.restoreSourceSession(owner, execution)
    const owned = this.host.ownedSessions.get(execution.id)
    if (!owned?.session) return work()
    const session = owned.session, generation = owned.generation
    const check = () => {
      owner.assertOwned()
      if (this.host.ownedSessions.get(execution.id) !== owned || owned.session !== session || owned.generation !== generation
        || owned.context.purpose === 'reviewer' || owned.failed || owned.cleanup || owned.opening || owned.controller.signal.aborted)
        throw new DomainError('SOURCE_NATIVE_SESSION_CONFLICT', 'The original resident workflow source owner changed.', 409)
    }
    check()
    const active = owned.manager.capturedLease(session)
    const observe = async () => { check(); const value = await work(); check(); return value }
    if (active) { await active.guard.check(); const value = await observe(); await active.guard.check(); return value }
    return owned.manager.withLane(session, `execution:${execution.id}`, owned.controller.signal, observe)
  }

  /** Read-only current manager/lease facts; absence is not replaced with a historic lane. */
  passiveOwnedNativeSessions() {
    return [...this.host.ownedSessions.values()].flatMap(owned => {
      if (!owned.session || owned.consultation || owned.failed || owned.cleanup) return []
      const lease = owned.manager.capturedLease(owned.session)
      const manager = this.host.rawManagers.get(owned.manager)
      if (!lease || !manager || lease.guard.signal.aborted) return []
      const session = owned.session, generation = owned.generation
      return [{ execution: structuredClone(owned.execution), session: structuredClone(session), manager,
        generation, signal: lease.guard.signal, writer: { id: lease.fence.id, token: lease.fence.token, connectionGeneration: lease.previous.connectionGeneration },
        assertCurrent: () => {
          if (this.host.ownedSessions.get(owned.execution.id) !== owned || owned.generation !== generation || owned.session !== session
            || owned.failed || owned.cleanup || owned.controller.signal.aborted) throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'The captured native manager lifetime is no longer current.', 409)
          owned.manager.assertCapturedLease(session, lease)
        } }]
    })
  }

  async managerContext(
    execution: HarnessExecution,
    configuration: AgentConfigurationVersion,
    purpose?: NativeManagerResolutionContext['purpose'],
  ): Promise<NativeManagerResolutionContext> {
    if (!execution.workingDirectory) throw new Error('The durable execution has no accepted working directory.')
    if (configuration.id !== execution.agentConfigurationVersionId || configuration.agentId !== execution.agentId) {
      throw new Error('The pinned Agent configuration does not match its durable execution.')
    }
    assertActiveHarnessConfiguration(configuration.harness)
    const context = {
      harness: configuration.harness.harness, executionId: execution.id, agentId: execution.agentId,
      runId: execution.runId, attempt: execution.attempt,
      ...(execution.nativeSessionId ? { nativeSessionId: execution.nativeSessionId } : {}),
      workingDirectory: execution.workingDirectory, configuration,
      ...(purpose ? { purpose } : {}),
    }
    return this.host.prepareManagerContext ? this.host.prepareManagerContext(context) : context
  }

  resolveManager(context: NativeManagerResolutionContext, owner?: RunOwnership) {
    const resolved = this.host.managers.resolve(context, owner)
    if (resolved.manager.harness !== context.harness) {
      throw new Error('The resolved native manager does not match the durable execution harness.')
    }
    let manager = this.writers.get(resolved.manager)
    if (!manager) {
      manager = coordinateSessionManager(resolved.manager, this.host.interactions.coordination, context.agentId)
      this.writers.set(resolved.manager, manager)
      this.host.rawManagers.set(manager, resolved.manager)
    }
    return {
      ...resolved, manager,
      get processState() { return resolved.processState },
    }
  }

  async workflowRequest(execution: HarnessExecution, configuration: AgentConfigurationVersion,
    run: Pick<WorkflowRun, 'id' | 'workflowVersionId' | 'workspaceId' | 'resultProtocol'>, owner?: RunOwnership) {
    const version = await this.host.runs.getRepeatVersion(run.id, run.workflowVersionId, owner)
    let executionContext
    if (version.definition.handoffs && repeatTickIndex(execution.input) === undefined) {
      const retained = owner ? undefined : await this.host.retainRunOwner(execution, () => {})
      try {
        executionContext = await (await this.host.runs.repeat(owner ?? retained!.owner)).readWorkExecutionContext(execution.id)
      } finally { await retained?.release() }
    }
    const retained = !owner ? await this.host.retainRunOwner(execution, () => {}) : undefined
    let collaborationPrompt: string | undefined
    let queuedInput: WorkflowQueuedInput | undefined
    try {
      const currentOwner = owner ?? retained!.owner
      collaborationPrompt = await this.host.collaboration?.readPrompt(currentOwner, execution, version)
      queuedInput = await (await this.host.runs.repeat(currentOwner)).claimWorkflowInput(execution.id)
    }
    finally { await retained?.release() }
    const team = await readWorkflowTeam(version, execution.workflowNodeId, id => this.host.runs.getExecutionConfiguration(id))
    return appendWorkflowChatInput(workflowExecutionRequest({ execution, version, configuration, workspaceId: run.workspaceId, executionContext, collaborationPrompt, team,
      ...(run.resultProtocol ? { resultProtocol: run.resultProtocol } : {}) }), queuedInput)
  }

  prepareEnvironment(
    context: NativeManagerResolutionContext,
    resolved: ResolvedNativeSessionManager,
    options: { signal?: AbortSignal | undefined; purpose?: 'reviewer' | undefined;
      enterNative?: () => Promise<void>; restartOwner?: RunOwnership | undefined },
  ): Promise<IssuedWorkerCredential['environment'] | undefined> {
    const owned = this.host.ownedSessions.get(context.executionId)!
    const preparation = this.prepareOwnedEnvironment(context, resolved, options).finally(() => {
      if (owned.preparing === preparation) delete owned.preparing
    })
    owned.preparing = preparation
    return preparation
  }

  private async prepareOwnedEnvironment(
    context: NativeManagerResolutionContext,
    resolved: ResolvedNativeSessionManager,
    options: { signal?: AbortSignal | undefined; purpose?: 'reviewer' | undefined;
      enterNative?: () => Promise<void>; restartOwner?: RunOwnership | undefined },
  ) {
    const { signal, purpose, enterNative, restartOwner } = options
    restartOwner?.assertOwned()
    const owned = this.host.ownedSessions.get(context.executionId)
    if (!owned || owned.manager !== resolved.manager) throw new Error('Native preflight has no exact manager owner.')
    const continuing = restartOwner && owned.session && resolved.processState === 'needs_start'
      && context.acceptedPlacement?.hostRef.kind === 'device'
      ? await readRemoteWorkflowContinuation(restartOwner, owned.execution) : undefined
    if (continuing) {
      this.assertSessionIdentity(continuing.session, owned.session!)
      if (!continuing.detached) {
        owned.closureRegistration = Promise.resolve(continuing.generation)
        owned.closureGeneration = continuing.generation
      }
    }
    if (this.host.workflowClosures) {
      // The original process intent must be durable before entered commits.
      // Allocation/reviewer cleanup alone must not reserve or dispatch anything.
      if (resolved.processState === 'needs_start' && !owned.launchReserved && !continuing) {
        signal?.throwIfAborted()
        owned.launchReservation ??= Promise.resolve().then(async () => {
          await this.host.reserveNativeLaunch?.(context.executionId, this.host.rawManagers.get(owned.manager) ?? owned.manager)
          owned.launchReserved = true
        })
        await owned.launchReservation
      }
      owned.closureRegistration ??= this.host.workflowClosures.begin(owned.execution)
      const generation = await owned.closureRegistration
      if (owned.closureGeneration !== generation) {
        this.host.closedExecutions.delete(context.executionId)
        this.host.closedWorkflowSessions.delete(context.executionId)
        owned.closureGeneration = generation
      }
      if (owned.restartRecovery) owned.restartRecovery.attachmentGeneration = generation
      signal?.throwIfAborted()
      if (this.host.ownedSessions.get(context.executionId) !== owned || owned.controller.signal.aborted) {
        throw new Error('Native preflight lost its manager owner.')
      }
    }
    await enterNative?.()
    signal?.throwIfAborted()
    if (!this.host.credentials) return undefined
    if (owned.session && owned.restartAttachment && context.acceptedPlacement?.hostRef.kind === 'device'
      && resolved.processState === 'needs_start') {
      if (!this.host.credentials.restore) throw new DomainError('NATIVE_CREDENTIAL_RECOVERY_REQUIRED',
        'The original Worker credential cannot be restored.', 409)
      const { session, request } = owned.restartAttachment
      const lane = await this.host.interactions.coordination.getLane(session.harness, session.nativeSessionId)
      const identity = reviewPreflightIdentity(lane, `execution:${context.executionId}`)
      const attached = await this.host.lifecycle.openingSession(owned,
        resolved.manager.attachSession(session, { request, ...identity }, signal))
      this.assertSessionIdentity(session, attached)
      const completed = async () => {
        const history = await resolved.manager.reconcile(session, identity.correlationId, signal)
        const terminal = history.terminalTurn
        return terminal?.correlationId === identity.correlationId
          && history.correlationId === terminal.correlationId
          && terminal.providerId === (history.nativeTurnId ?? history.nativeMessageId)
          && !history.pendingInteraction && history.pendingInteractions.length === 0
      }
      if (await completed()) {
        owned.terminalRecoveredWithoutCredential = true
        resolved.markResident?.()
        return undefined
      }
      const originalApplicationAccess = resolved.manager.originalApplicationAccess
      if (!originalApplicationAccess) throw new DomainError('NATIVE_CREDENTIAL_RECOVERY_REQUIRED',
        'The original Worker application access cannot be restored.', 409)
      let access: Awaited<ReturnType<typeof originalApplicationAccess>>
      try { access = await originalApplicationAccess.call(resolved.manager, session, signal) }
      catch (error) {
        if (!await completed()) throw error
        owned.terminalRecoveredWithoutCredential = true
        resolved.markResident?.()
        return undefined
      }
      const credential = await this.host.credentials.restore(context.executionId, { agentId: context.agentId,
        variables: { [APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]: access.token } })
      if (continuing) {
        const current = await readRemoteWorkflowContinuation(restartOwner!, owned.execution)
        const expected = { ...continuing, generation: owned.closureGeneration, detached: false }
        if (credential.principalId !== continuing.principalId || !isDeepStrictEqual(current, expected)) {
          throw new DomainError('NATIVE_CREDENTIAL_RECOVERY_REQUIRED', 'The original remote process lease changed.', 409)
        }
      }
      if (owned.closureGeneration) credential.nativeLifetimeGeneration = owned.closureGeneration
      this.host.credentialLedger.set(resolved.manager, credential)
      signal?.throwIfAborted()
      resolved.markResident?.()
      return undefined
    }
    if (owned.session && resolved.manager.originalEnvironment && resolved.processState === 'needs_start') {
      const variables = await resolved.manager.originalEnvironment(owned.session, signal)
      if (variables) {
        if (!this.host.credentials.restore) throw new DomainError('NATIVE_CREDENTIAL_RECOVERY_REQUIRED',
          'The original native process credential cannot be restored.', 409)
        const credential = await this.host.credentials.restore(context.executionId, { agentId: context.agentId, variables })
        if (owned.closureGeneration) credential.nativeLifetimeGeneration = owned.closureGeneration
        this.host.credentialLedger.set(resolved.manager, credential)
        signal?.throwIfAborted()
        return credential.environment
      }
    }
    if (resolved.processState === 'resident') {
      const credential = this.host.credentialLedger.get(resolved.manager)
      if (!credential) throw new Error('The resident native process has no owned worker credential lease.')
      const remaining = remainingCredentialLifetime(credential)
      if (!Number.isFinite(remaining)) throw new Error('The worker credential expiry is invalid.')
      if (remaining <= 0) {
        throw new Error('The resident worker credential cannot be renewed without replacing its process.')
      }
      if (this.host.credentials.renew && remaining <= WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) {
        await this.host.credentialLedger.renew(resolved.manager, context.executionId, {
          signal,
          check: async () => { signal?.throwIfAborted() },
        })
      }
      signal?.throwIfAborted()
      // A resident process keeps its original token/environment, including across long waits.
      return undefined
    }
    const prepared = await this.host.credentials.prepare({
      executionId: context.executionId, harness: context.harness, workingDirectory: context.workingDirectory,
      ...(purpose ? { purpose } : {}),
      ...(signal ? { signal } : {}),
    })
    const remaining = remainingCredentialLifetime(prepared.credential)
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('The prepared worker credential is not live.')
    if (owned.closureGeneration) prepared.credential.nativeLifetimeGeneration = owned.closureGeneration
    this.host.credentialLedger.set(resolved.manager, prepared.credential)
    signal?.throwIfAborted()
    return prepared.credential.environment
  }

  maintainWaitingWorkflowCredential(owned: OwnedNativeSession): void {
    const initial = this.host.credentialLedger.get(owned.manager)
    const session = owned.session
    if (owned.stopWaitingRenewal || !initial || !session || !this.host.credentials?.renew) return
    const generation = owned.generation
    const lifetime = owned.closureGeneration
    const check = async () => {
      owned.controller.signal.throwIfAborted()
      const credential = this.host.credentialLedger.get(owned.manager)
      if (this.host.ownedSessions.get(owned.execution.id) !== owned || !isDeepStrictEqual(owned.session, session)
        || owned.generation !== generation || owned.closureGeneration !== lifetime || owned.failed || owned.cleanup
        || credential?.principalId !== initial.principalId || credential.environment !== initial.environment) {
        throw new DomainError('WORKER_CREDENTIAL_LOST', 'The waiting requester no longer owns its native lifetime.', 409)
      }
      const current = await this.host.runs.getExecution(owned.execution.id)
      if (!current || current.state !== 'waiting') throw new DomainError(
        'WORKER_EXECUTION_TERMINAL', 'The requester no longer has a pending approval wait.', 409)
      assertSameRepeatExecution(owned.execution, current)
      if (current.nativeSessionId !== session.nativeSessionId) throw new DomainError(
        'NATIVE_SESSION_IDENTITY_MISMATCH', 'The waiting requester session changed.', 409)
      await this.host.validateContinuation?.(owned.execution.id, owned.controller.signal)
      owned.controller.signal.throwIfAborted()
    }
    owned.stopWaitingRenewal = renewOwnedLeases({
      signal: owned.controller.signal,
      check,
      leases: [this.host.credentialLedger.lease(owned.manager, async () => {
        try {
          await owned.manager.withCredentialLease(session, owned.controller.signal, async signal => {
            await this.host.credentialLedger.renew(owned.manager, owned.execution.id, { signal, check: async () => {
              signal.throwIfAborted()
              await check()
              signal.throwIfAborted()
            } })
          })
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== 'SESSION_LANE_BUSY') throw error
          const busy = new DomainError('WORKER_CREDENTIAL_RENEWAL_BUSY',
            'The requester is completing another native operation.', 503, { retryable: true })
          busy.cause = error
          throw busy
        }
      })],
      onFailure: error => owned.controller.abort(error),
    })
  }
  /** Read-only exact callback qualification. A cold read never allocates or attaches a manager. */
  async inspectInteractionActivity(interaction: DurableInteraction): Promise<InteractionActivityEvidence> {
    const identity = { interactionId: interaction.id, revision: interaction.revision, sessionId: interaction.nativeSessionId,
      requestId: interaction.nativeRequestId, executionId: interaction.executionId }
    const unavailable: InteractionActivityEvidence = { response: { authorized: false, qualified: false,
      path: null, usable: false, identity } }
    const owned = this.host.ownedSessions.get(interaction.executionId)
    if (!owned?.session || this.host.closing || owned.failed || owned.cleanup || owned.openingFailed
      || owned.controller.signal.aborted || this.host.stoppingRuns.has(interaction.runId)) return unavailable
    const execution = await this.host.runs.getExecution(interaction.executionId)
    const run = await this.host.runs.get(interaction.runId)
    if (!execution || !run || execution.runId !== interaction.runId || execution.agentId !== interaction.requestingAgentId
      || execution.nativeSessionId !== interaction.nativeSessionId || execution.state === 'completed'
      || run.workspaceId !== interaction.workspaceId || run.workflowId !== interaction.workflowId || run.outcome !== 'pending'
      || owned.execution.id !== execution.id || owned.execution.attempt !== execution.attempt
      || owned.session.nativeSessionId !== interaction.nativeSessionId || owned.session.harness !== interaction.harness
      || owned.session.providerVersion !== interaction.providerVersion) return unavailable
    const manager = this.host.rawManagers.get(owned.manager) ?? owned.manager
    const response = await inspectNativeResponse(manager, owned.session, {
      nativeRequestId: interaction.nativeRequestId, nativeRequestType: interaction.nativeRequestType,
    }, { signal: AbortSignal.any([owned.controller.signal, AbortSignal.timeout(5_000)]),
      isCurrent: () => this.host.ownedSessions.get(execution.id) === owned && !this.host.closing && !owned.cleanup
        && !owned.failed && !owned.controller.signal.aborted && !this.host.stoppingRuns.has(interaction.runId) })
    return { response: { authorized: false, qualified: response.qualified, usable: response.state === 'available',
      path: response.state === 'available' ? response.path : null, identity },
      ...(response.nativeTurnId ? { nativeTurnId: response.nativeTurnId } : {}) }
  }

  async validateInteraction(interaction: DurableInteraction, signal?: AbortSignal): Promise<void> {
    await this.host.validateContinuation?.(interaction.executionId, signal)
  }

  hasOriginalRequester(interaction: DurableInteraction): boolean {
    const owned = this.host.ownedSessions.get(interaction.executionId)
    return !!owned?.session && !owned.failed && !owned.cleanup && !owned.opening
      && !owned.openingFailed && !owned.pendingApprovalRestoration && owned.generation > 0
      && !owned.controller.signal.aborted && owned.execution.runId === interaction.runId
      && owned.session.nativeSessionId === interaction.nativeSessionId
      && owned.session.harness === interaction.harness
      && owned.session.providerVersion === interaction.providerVersion
  }

  async withInteractionOwner<T>(interaction: DurableInteraction, signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const owned = this.host.ownedSessions.get(interaction.executionId)
    if (owned?.context.acceptedPlacement?.hostRef.kind !== 'device') return work(signal)
    if (owned.execution.runId !== interaction.runId) throw new DomainError(
      'INTERACTION_RUN_MISMATCH', 'The native interaction does not belong to this Run.', 409)
    signal.throwIfAborted()
    const controller = new AbortController()
    const retained = await this.host.retainRunOwner(owned.execution, () => controller.abort())
    try {
      const ownedSignal = AbortSignal.any([signal, controller.signal])
      ownedSignal.throwIfAborted()
      this.host.adoptRunOwner(retained.owner)
      return await work(ownedSignal)
    } finally { await retained.release() }
  }

  async attachInteraction(interaction: DurableInteraction, signal?: AbortSignal): Promise<AttachedInteractionSession> {
    if (interaction.harness === 'opencode') {
      throw retiredHarnessError()
    }
    const execution = await this.host.runs.getExecution(interaction.executionId)
    if (!execution?.workingDirectory || !execution.runtimeDirectory) throw new Error('The durable execution cannot reconstruct its native session start input.')
    if (execution.agentId !== interaction.requestingAgentId || execution.runId !== interaction.runId) {
      throw new Error('The interaction requester does not own its durable execution.')
    }
    return this.attachOwnedSession({
      harness: interaction.harness, executionId: execution.id, agentId: execution.agentId,
      workingDirectory: execution.workingDirectory,
    }, {
      harness: interaction.harness, providerVersion: interaction.providerVersion,
      nativeSessionId: interaction.nativeSessionId,
    }, signal)
  }

  async attachOwnedSession(
    context: NativeManagerOwnershipContext,
    sessionReference: { harness: NativeManagerResolutionContext['harness']; providerVersion: string; nativeSessionId: string },
    signal?: AbortSignal,
  ): Promise<AttachedInteractionSession> {
    return this.attachSession(context, sessionReference, { signal })
  }

  private async attachSession(
    context: NativeManagerOwnershipContext,
    sessionReference: NativeSessionReference,
    options: { signal?: AbortSignal | undefined; restartOwner?: RunOwnership },
  ): Promise<AttachedInteractionSession> {
    let signal = options.signal
    options.restartOwner?.assertOwned()
    const execution = await this.host.runs.getExecution(context.executionId)
    if (!execution?.workingDirectory || !execution.runtimeDirectory || execution.agentId !== context.agentId
      || execution.workingDirectory !== context.workingDirectory
      || execution.nativeSessionId !== sessionReference.nativeSessionId || sessionReference.harness !== context.harness) {
      throw new Error('The native session ownership context does not match its durable execution.')
    }
    if (context.purpose === 'reviewer') {
      const configuration = await this.host.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
      if (!configuration) throw new Error('The reviewer configuration is unavailable')
      const placementContext = await this.managerContext(execution, configuration)
      if (placementContext.acceptedPlacement?.hostRef.kind === 'device') {
        const controller = new AbortController()
        const { owner, release: releaseOwner } = await this.host.retainRunOwner(execution, () => controller.abort())
        try {
          await this.host.reviewerSessions.recoverRetainedReviewer(execution, owner, signal, context.reviewJob)
          const owned = this.host.ownedSessions.get(execution.id)
          if (!owned?.session || !owned.manager.retainsReviewerSession) throw new DomainError('REVIEWER_AUTHORITY_LOST',
            'The original remote reviewer is no longer resident.', 409)
          if (owned.reviewOwner) throw new DomainError('SESSION_LANE_BUSY', 'The reviewer already owns an active review.', 409)
          this.assertSessionIdentity(owned.session, sessionReference)
          owned.reviewOwner = owner
          owned.releaseReviewOwner = releaseOwner
          this.host.adoptRunOwner(owner)
          const combined = AbortSignal.any([owned.controller.signal, controller.signal, ...(signal ? [signal] : [])])
          if (context.reviewJob) {
            const credential = this.host.credentialLedger.get(owned.manager)
            if (!credential || !this.host.credentials?.bindReviewerJob) throw new DomainError('REVIEWER_CREDENTIAL_LOST',
              'The original reviewer credential cannot bind its current job.', 409)
            await this.host.credentials.bindReviewerJob(execution.id, credential, context.reviewJob)
          }
          await this.host.reviewerSessions.validateReviewer(owned, sessionReference, combined)
          return { manager: owned.manager, session: sessionReference, signal: combined }
        } catch (error) {
          const owned = this.host.ownedSessions.get(execution.id)
          if (owned?.releaseReviewOwner === releaseOwner) {
            delete owned.reviewOwner
            delete owned.releaseReviewOwner
          }
          await releaseOwner()
          throw error
        }
      }
    }
    const continuing = !this.host.ownedSessions.has(execution.id) && options.restartOwner
      ? await readRemoteWorkflowContinuation(options.restartOwner, execution) : undefined
    let recovery: Awaited<ReturnType<typeof readDetachedWorkflowLifetime>>
      | Awaited<ReturnType<typeof readRemoteWorkflowContinuation>> = undefined
    if (!this.host.ownedSessions.has(execution.id)) {
      const detached = options.restartOwner
        ? await this.detachedWorkflowSession(options.restartOwner, execution) : undefined
      if (continuing) this.assertSessionIdentity(continuing.session, sessionReference)
      else if (detached) this.assertSessionIdentity(detached, sessionReference)
      else if (execution.state !== 'completed' || !await this.host.workflowClosures?.read(execution)) throw new DomainError(
        'NATIVE_SESSION_RECOVERY_REQUIRED', 'The original requester requires verified Run recovery.', 409)
      recovery = continuing ?? (detached && options.restartOwner
        ? await readDetachedWorkflowLifetime(options.restartOwner, execution) : undefined)
      if (options.restartOwner && (continuing || detached)) {
        await this.waitForRestartWriter(options.restartOwner, execution, sessionReference,
          context.correlationId ?? `execution:${execution.id}`, continuing
            ? () => readRemoteWorkflowContinuation(options.restartOwner!, execution)
            : () => readDetachedWorkflowLifetime(options.restartOwner!, execution), signal)
      }
    }
    const run = await this.host.runs.get(execution.runId)
    if (!run) throw new Error('The durable execution Run is unavailable.')
    if (run.executionState === 'completed') throw new Error('A completed Run cannot restart native work.')
    const configuration = await this.host.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    if (!configuration || configuration.harness.harness !== context.harness) throw new Error('The durable execution configuration is unavailable or mismatched.')
    if (context.purpose === 'reviewer') {
      const previous = this.host.ownedSessions.get(execution.id)
      if (previous?.cleanup || previous?.reviewFinishing) throw new DomainError('SESSION_LANE_BUSY',
        'The captured reviewer lifetime is still closing.', 409)
      const native = await this.host.interactions.coordination.workflowSession(execution.id)
      if ((configuration.productRole !== 'master' && configuration.productRole !== 'orchestrator') || !isRunInProgress(run.executionState)
        || run.outcome !== 'pending' || execution.state !== 'completed' || !native?.finalized || run.approval?.handler !== 'orchestrator'
        || run.approval.designatedOrchestratorAgentId !== execution.agentId) {
        throw new DomainError('SESSION_LANE_BUSY', 'Workflow finalization must finish before review attachment.', 409)
      }
      this.assertSessionIdentity(native.session, sessionReference)
    } else if (execution.state === 'completed') {
      throw new DomainError('WORKER_EXECUTION_TERMINAL', 'A completed workflow execution cannot resume native work.', 409)
    }
    await this.host.validateContinuation?.(execution.id, signal)
    let request = this.host.ownedSessions.get(execution.id)?.context.workflowRequest
    if (!request) {
      request = await this.workflowRequest(execution, configuration, run, options.restartOwner)
    }
    const resolutionContext = {
      ...await this.managerContext(execution, configuration, context.purpose), workflowRequest: request,
    }
    if (this.host.stoppingRuns.has(execution.runId)) throw new Error('The Run is stopping.')
    const resolved = this.resolveManager(resolutionContext, options.restartOwner)
    const retryingAttachment = resolved.lifecycle === 'starting'
      && this.host.ownedSessions.get(execution.id)?.pendingApprovalRestoration
    // Claim outside cleanup: losing a concurrent startup race does not own its credentials.
    if (resolved.processState === 'needs_start' && !retryingAttachment) resolved.beginStart?.()
    const owned = this.host.lifecycle.ownSession(execution, resolutionContext, resolved.manager)
    if (options.restartOwner) owned.runOwner = options.restartOwner
    if (continuing) {
      owned.closureRegistration = Promise.resolve(continuing.generation)
      owned.closureGeneration = continuing.generation
    }
    if (recovery && options.restartOwner) {
      owned.restartRecovery ??= { ...recovery, owner: options.restartOwner }
      if (owned.closureGeneration) owned.restartRecovery.attachmentGeneration = owned.closureGeneration
    }
    owned.session = sessionReference
    signal = signal ? AbortSignal.any([signal, owned.controller.signal]) : owned.controller.signal
    if (resolutionContext.acceptedPlacement?.hostRef.kind === 'device'
      || resolutionContext.harness === 'codex' && !resolutionContext.purpose) {
      owned.restartAttachment = { session: sessionReference, request }
    }
    try {
      if (continuing) {
        if (!this.host.credentials?.restore || !resolved.manager.originalApplicationAccess) throw new DomainError(
          'NATIVE_CREDENTIAL_RECOVERY_REQUIRED', 'The original remote process credential cannot be restored.', 409)
        if (continuing.detached) {
          if (!this.host.workflowClosures) throw new DomainError('NATIVE_WORKFLOW_CLOSURE_CONFLICT',
            'The detached native lifetime cannot reserve its attachment.', 409)
          owned.closureRegistration = this.host.workflowClosures.begin(execution)
          owned.closureGeneration = await owned.closureRegistration
          if (owned.restartRecovery) owned.restartRecovery.attachmentGeneration = owned.closureGeneration
        }
        const session = await this.host.lifecycle.openingSession(owned, resolved.manager.attachSession(sessionReference,
          { kind: 'workflow', correlationId: `execution:${execution.id}`, request }, signal))
        this.assertSessionIdentity(sessionReference, session)
        const access = await resolved.manager.originalApplicationAccess(session, signal)
        const credential = await this.host.credentials.restore(execution.id, { agentId: execution.agentId,
          variables: { [APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]: access.token } })
        const current = await readRemoteWorkflowContinuation(options.restartOwner!, execution)
        const expected = { ...continuing, generation: owned.closureGeneration, detached: false }
        if (credential.principalId !== continuing.principalId || !isDeepStrictEqual(current, expected))
          throw new DomainError('NATIVE_CREDENTIAL_RECOVERY_REQUIRED', 'The original remote process lease changed.', 409)
        if (owned.closureGeneration) credential.nativeLifetimeGeneration = owned.closureGeneration
        this.host.credentialLedger.set(resolved.manager, credential)
        await this.host.validateContinuation?.(execution.id, signal)
        signal.throwIfAborted()
        resolved.markResident?.()
        return { manager: resolved.manager, session, signal: owned.controller.signal }
      }
      const environment = await this.prepareEnvironment(resolutionContext, resolved, {
        signal, ...(context.purpose === 'reviewer' ? { purpose: context.purpose } : {}), restartOwner: options.restartOwner,
      })
      await this.host.validateContinuation?.(execution.id, signal)
      options.restartOwner?.assertOwned()
      signal.throwIfAborted()
      if (resolved.processState === 'resident') {
        await resolved.manager.history(sessionReference, signal)
        return { manager: resolved.manager, session: sessionReference, signal: owned.controller.signal }
      }
      const session = await this.host.lifecycle.openingSession(owned, resolved.manager.attachSession(sessionReference, {
        kind: 'workflow', correlationId: context.correlationId ?? `execution:${execution.id}`, request,
        ...(context.nativeTurnId ? { nativeTurnId: context.nativeTurnId } : {}),
        ...(environment ? { environment } : {}),
      }, signal))
      this.assertSessionIdentity(sessionReference, session)
      resolved.markResident?.()
      signal.throwIfAborted()
      return { manager: resolved.manager, session, signal: owned.controller.signal }
    } catch (error) {
      const safe = nativePersistenceRedactor(this.host.credentialLedger.secrets(owned.manager))
      if (isRestartCancellation(error, signal)) throw safe.error(error)
      componentLogger('harness').warn({ err: safe.error(error), executionId: execution.id },
        'workflow approval attachment failed')
      if (isTransientExecutionError(error) || isTransientRefreshFailure(error) || isLeaseLost(error)
        || (error instanceof DomainError && error.code === 'SESSION_LANE_BUSY')) throw safe.error(error)
      resolved.markFailed?.()
      owned.failed = true
      if (options.restartOwner) throw safe.error(error)
      await this.host.lifecycle.cleanupSession(owned)
      throw safe.error(error)
    }
  }

  async restorePendingWorkflowApprovals(owner: RunOwnership, execution: HarnessExecution,
    pending: readonly DurableInteraction[], signal?: AbortSignal): Promise<boolean> {
    const resident = this.host.ownedSessions.get(execution.id)
    const detached = resident?.restartAttachment?.session ?? await this.detachedWorkflowSession(owner, execution)
      ?? (await readRemoteWorkflowContinuation(owner, execution))?.session
    if (!detached) return false
    if (detached.harness === 'opencode') {
      throw retiredHarnessError()
    }
    if (pending.some((item) => item.runId !== owner.runId || item.nativeSessionId !== detached.nativeSessionId
      || item.harness !== detached.harness || item.providerVersion !== detached.providerVersion
      || item.requestingAgentId !== execution.agentId || !item.graphInterruptId)) {
      throw new DomainError('INTERACTION_IDENTITY_CONFLICT', 'Restart approval changed its saved native identity.', 409)
    }
    const originals = await owner.oneShotConnection().transaction(async (sql) => {
      await openWorkflowLifecycleLocked(sql, owner.runId)
      const requests: PendingNativeInteraction[] = []
      let correlationId = `execution:${execution.id}`
      for (const item of pending) {
        const proof = await assertSavedPendingApprovalOriginalLocked(sql, item)
        if (proof.original.type !== 'history') throw new DomainError(
          'APPROVAL_ORIGINAL_SOURCE_REQUIRED', 'The approval has no saved native request.', 409)
        if (!requests.length) correlationId = proof.original.history.correlationId ?? correlationId
        requests.push(proof.original.history.pendingInteractions.find((request) =>
          request.turn.nativeRequestId === item.nativeRequestId)!)
      }
      return { requests, correlationId }
    })
    try {
      const first = originals.requests[0]!
      const attached = await this.attachSession({ harness: detached.harness, executionId: execution.id,
        agentId: execution.agentId, workingDirectory: execution.workingDirectory!, correlationId: originals.correlationId,
        ...(first.turn.nativeTurnId ? { nativeTurnId: first.turn.nativeTurnId } : {}),
      }, detached, { signal, restartOwner: owner })
      const history = await attached.manager.reconcile(detached, originals.correlationId, attached.signal)
      owner.assertOwned()
      for (const [index, original] of originals.requests.entries()) {
        const restored = history.pendingInteractions.find((request) =>
          request.turn.nativeRequestId === original.turn.nativeRequestId)
        // A started or delivered answer may already have consumed the native request.
        if (restored ? !isDeepStrictEqual(restored, original) : nativeDispatchNotStarted(pending[index]!)) throw new DomainError(
          'NATIVE_SESSION_IDENTITY_MISMATCH', 'The restored session has no matching pending approval.', 409)
      }
      const owned = this.host.ownedSessions.get(execution.id)
      if (owned) {
        delete owned.pendingApprovalRestoration
        this.maintainWaitingWorkflowCredential(owned)
      }
      return true
    } catch (error) {
      owner.assertOwned()
      signal?.throwIfAborted()
      if (isTransientExecutionError(error) || isTransientRefreshFailure(error)) {
        const owned = this.host.ownedSessions.get(execution.id)
        if (owned) {
          owned.pendingApprovalRestoration = true
          if (!owned.openingFailed && owned.generation > 0) this.maintainWaitingWorkflowCredential(owned)
        }
        throw error
      }
      await this.host.runs.requestCleanup(owner.runId, owner)
      const owned = this.host.ownedSessions.get(execution.id)
      if (!owned) throw error
      const safe = nativePersistenceRedactor(this.host.credentialLedger.secrets(owned.manager))
      owned.controller.abort(error)
      // Dispose the attempted attachment; the cold registry still has to prove physical closure.
      await owned.manager.dispose()
      this.host.credentialLedger.delete(owned.manager)
      this.host.managers.release?.(owned.context, this.host.rawManagers.get(owned.manager) ?? owned.manager, 'failed')
      if (this.host.ownedSessions.get(execution.id) === owned) this.host.ownedSessions.delete(execution.id)
      componentLogger('harness').warn({ err: safe.error(error), executionId: execution.id }, 'workflow approval restoration requires cleanup')
      return false
    }
  }

  assertSessionIdentity(expected: NativeSessionReference, actual: NativeSessionReference): void {
    if (expected.harness !== actual.harness || expected.providerVersion !== actual.providerVersion
      || expected.nativeSessionId !== actual.nativeSessionId) {
      throw new DomainError('NATIVE_SESSION_IDENTITY_MISMATCH', 'The native manager returned a different session identity.', 409)
    }
  }

  /** Resume values are delivery notifications, never decisions for the currently pending request. */
  async assertResume(execution: HarnessExecution, value: unknown): Promise<void> {
    const id = value && typeof value === 'object' && 'interactionId' in value ? value.interactionId : undefined
    const interaction = typeof id === 'string' ? await this.host.interactions.get(id) : undefined
    const configuration = await this.host.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    if (!interaction || interaction.deliveryState !== 'delivered'
      || !configuration || configuration.harness.harness !== interaction.harness
      || interaction.executionId !== execution.id || interaction.runId !== execution.runId
      || interaction.requestingAgentId !== execution.agentId
      || interaction.nativeSessionId !== execution.nativeSessionId) {
      throw new DomainError('GRAPH_INTERRUPT_RESUME_INVALID', 'The resume value is not a delivered interaction for this execution.', 409)
    }
  }
}

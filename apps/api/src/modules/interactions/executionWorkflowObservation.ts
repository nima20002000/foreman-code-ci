import { MemoryResultRejected } from '../collaboration/memoryResultError.js'
import { isDatabaseTimeout, retryDatabaseTimeout } from '../../infrastructure/databaseRetry.js'
import { timeRuntimeOperation, withRuntimeTimingContext } from '../../infrastructure/runtimeTiming.js'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { HarnessExecutionSchema, ExecutionResultSchema, type DurableInteraction, type ExecutionResult, type HarnessExecution, type HarnessExecutionRequest, type NativeSessionReference, type NativeHarnessEvent, HarnessExecutionRequestSchema } from '@foreman-code/contracts'
import { remainingCredentialLifetime } from '../access/credentialLifetime.js'
import { WORKER_CREDENTIAL_RENEWAL_WINDOW_MS } from '../access/workerCredentials.js'
import type { NativeHarnessSessionManager, NativeHistory } from '../harnesses/port.js'
import { DomainError } from '../errors.js'
import { appendWorkflowChatInput } from './workflowChatInput.js'
import { nativePersistenceRedactor } from './nativePersistence.js'
import { workResultRepairPrompt } from './workResultRepair.js'
import { deliverableRepairPrompt, deliverableVerdict, nativeOutputSchema } from './deliverable.js'
import { NATIVE_EVENT_BATCH_SIZE } from './nativeEventBatches.js'
import { assertOriginalWorkflowTerminal } from './workflowTerminalSource.js'
import { workResultRepairCorrelation } from '../runs/workResultRepair.js'
import { KANBAN_FOLLOW_UP } from '../runs/kanbanRecord.js'
import { isWorkflowResultEffectFailure } from '../runs/workflowResultEffectFailure.js'
import { reviewTurnEvidence } from './reviewerEvidence.js'
import { isLeaseLost, type SingleWriterSessionManager } from './sessionWriter.js'
import { HarnessExecutionError } from '../harnesses/errors.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import { attemptCleanup } from './cleanup.js'
import { deviceRequestTimeoutMs } from '../devices/deviceRequestRetry.js'
import { buildHarnessPrompt } from '../harnesses/prompt.js'
import { renewOwnedLeases } from '../leases/ownerLeases.js'
import { componentLogger } from '../diagnostics/logger.js'
import { isTransientExecutionError, isTransientExecutionResult, transientExecutionFailure } from '../runs/executionRetryPolicy.js'
import type { PostgresRunRepository } from '../runs/index.js'
import type { RunOwnership } from '../runs/index.js'
import { capturedWorkflowNativeTime, type WorkflowOriginalNativeSource } from './workflowNativeCapture.js'
import type { RepeatNativeEvidence } from '../runs/index.js'
import type { SessionWriteLease } from './sessionWriter.js'
import type { WorkflowNativeLease } from '../runs/index.js'
import { normalizeNativeProducerEvent } from '../run-graph/nativeProducerNormalization.js'
import type { NativeManagerResolutionContext, ResolvedNativeSessionManager } from './runtimePorts.js'
import { readDetachedWorkflowLifetime, readRemoteWorkflowContinuation, readRemoteOutputSettlement } from './workflowClosure.js'
import { finishRecoveredWorkflowCredentials } from './workflowTerminalRecovery.js'
import { repeatTickIndex } from '../runs/repeatResolution.js'
import { assertSameRepeatExecution, repeatPhysicalSettlementPending, type RepeatNativeObservationStore } from './repeatObservation.js'
import type { ApprovalExecutionObservation, ApprovalObservationInput, ExecutionSessionHost, OwnedNativeSession } from './executionSessionHost.js'

interface WorkflowObservationState {
  input: ApprovalObservationInput
  ensured: { execution: HarnessExecution; created: boolean }
  repeat: RepeatNativeObservationStore
  credentialFailure: AbortController
  signal: AbortSignal
  execution: HarnessExecution
  repeatLaunch: boolean
  nativeTurnOffered: boolean
  workResultRepairs: number
  committedNativeSequences: Map<string, number>
  workflowCorrelation: string
  context?: NativeManagerResolutionContext | undefined
  manager?: SingleWriterSessionManager | undefined
  resolved?: (ResolvedNativeSessionManager & { manager: SingleWriterSessionManager }) | undefined
  ownedSession?: OwnedNativeSession | undefined
  session?: NativeSessionReference | undefined
  existing?: NativeSessionReference | undefined
  request?: HarnessExecutionRequest | undefined
  restartRecovery?: OwnedNativeSession['restartRecovery']
  stopRenewal?: (() => Promise<void>) | undefined
  finishStartup?: (() => void) | undefined
  budgetTimer?: ReturnType<typeof setTimeout> | undefined
  knownSecrets: string[]
  bookkeeping<T>(work: () => Promise<T>): Promise<T>
  validateContinuation(): Promise<void>
  assertBoundary(): Promise<void>
  watchCredential(): void
  safeValue<T>(value: T): T
  safeError(error: unknown): unknown
  startCredentialMaintenance(): void
  observePending(history: NativeHistory, sourceLease?: WorkflowNativeLease): Promise<ApprovalExecutionObservation | undefined>
}

/** Workflow observation, original native publication and terminal settlement. */
export class ExecutionWorkflowObservation {
  constructor(private readonly host: ExecutionSessionHost) {}

  /** First repair durable receipts. A terminal input cannot obtain a replacement
   * native process merely to clean it up. Related reviewers close via their own
   * captured job finalizers; the repository checks all their receipts together. */
  private async finishRepeatExecution(execution: HarnessExecution, store: RepeatNativeObservationStore,
    owner: RunOwnership, signal: AbortSignal): Promise<void> {
    const check = () => { signal.throwIfAborted(); owner.assertOwned() }
    check()
    if (execution.state !== 'completed' || !execution.result || !execution.finishedAt) throw new DomainError(
      'REPEAT_BOUNDARY_PENDING', 'Cleanup requires the exact durable terminal result.', 409)
    await this.settleRetainedWorkflowTerminal(execution, owner, signal)
    check()
    await this.recoverOutputSettlement(execution, owner, signal)
    const retained = this.host.ownedSessions.get(execution.id)
    const control = await (await this.host.runs.repeat(owner)).workflowControlDisposition(execution.id)
    if (retained?.manager.retainsReviewerSession && !retained.consultation && control.kind === 'ordinary') {
      retained.execution = execution
      await this.host.budgets.finish(execution.id, execution.finishedAt)
      await store.settleNativeExecution(execution.id)
      check()
      retained.context = { ...retained.context, purpose: 'reviewer' }
      this.host.reviewerSessions.maintainRetainedReviewer(retained)
      return
    }
    try { await store.settleNativeExecution(execution.id); check(); return }
    catch (error) { if (!repeatPhysicalSettlementPending(error)) throw error; check() }
    const owned = this.host.ownedSessions.get(execution.id)
    if (owned) {
      // Workflow terminal repair must never close a later reviewer lifetime on
      // the same execution. Only its captured review job may do that.
      if (owned.context.purpose === 'reviewer') throw new DomainError('REPEAT_CLEANUP_PENDING',
        'The exact reviewer lifetime is still responsible for its cleanup.', 409)
      assertSameRepeatExecution(owned.execution, execution)
      if (!owned.session || owned.session.nativeSessionId !== execution.nativeSessionId) throw new DomainError(
        'REPEAT_CLEANUP_PENDING', 'No captured session matches the terminal execution.', 409)
      owned.execution = execution
      await this.host.budgets.finish(execution.id, execution.finishedAt)
      check()
      await this.host.lifecycle.closeRepeatLifetime(owned, check,
        () => finishRecoveredWorkflowCredentials(owner, execution, this.host.credentials, signal))
    } else {
      // A crash after close/COMMIT is repaired without touching a native manager.
      // The proof reader rejects newer generations and any older unclosed one.
      const proof = await this.host.workflowClosures?.read(execution)
      check()
      if (!proof) throw new DomainError('REPEAT_CLEANUP_PENDING',
        'No durable exact-session closure exists. Native work will not be restarted.', 409)
      await this.host.budgets.finish(execution.id, execution.finishedAt)
      check()
      // Capture and revoke only exact workflow-purpose principals under the
      // owner/closure fence. Never revoke a successor reviewer's credential.
      await finishRecoveredWorkflowCredentials(owner, execution, this.host.credentials, signal)
      check()
    }
    check()
    await store.settleNativeExecution(execution.id)
    check()
  }

  private async finishOutputSettlement(owned: OwnedNativeSession, owner: RunOwnership,
    terminal: NonNullable<NativeHistory['terminalTurn']>, manager: NativeHarnessSessionManager,
    lane: SessionWriteLease): Promise<void> {
    const session = owned.session!
    const safe = nativePersistenceRedactor(this.host.credentialLedger.secrets(owned.manager))
    if (!manager.settleTurn) throw new DomainError('NATIVE_SETTLEMENT_UNAVAILABLE', 'The original native settlement port is unavailable.', 409)
    await this.host.interactions.coordination.acknowledgeLaneTurn(lane.fence, terminal.correlationId, terminal.providerId)
    lane.providerId = terminal.providerId
    const settled = await manager.settleTurn(session, terminal.correlationId, lane.guard.signal)
    assertOriginalWorkflowTerminal(owned.execution, session, settled, terminal.correlationId)
    if (!isDeepStrictEqual(settled.terminalTurn, terminal)) throw new DomainError(
      'NATIVE_TERMINAL_SOURCE_REQUIRED', 'The settled result differs from the validated provider output.', 409)
    const evidence = this.captureNative(owner, owned.execution,
      { type: 'history', history: safe.value(settled) }, 'recovery', lane)
    if (owned.execution.resultProtocol) await this.host.runs.publishWorkflowTerminalSettlement(owned.execution, owner, evidence)
    else await this.host.runs.retainSettledTerminal(owner, evidence)
    owned.outputSettlementComplete = true
  }

  async recoverOutputSettlement(execution: HarnessExecution, owner: RunOwnership,
    signal?: AbortSignal): Promise<boolean> {
    let owned = this.host.ownedSessions.get(execution.id)
    if (owned?.outputSettlementComplete || owned?.context.purpose === 'reviewer') return false
    if (owned && !this.host.rawManagers.get(owned.manager)?.settleTurn) return false
    const proof = await this.host.runs.readOutputSettlement(execution, owner)
    if (!proof || proof.original.type !== 'history' || !proof.original.history.terminalTurn) return false
    const terminal = proof.original.history.terminalTurn
    if (!owned) {
      const lifetime = await readRemoteOutputSettlement(owner, execution, proof)
      if (!lifetime) return false
      await this.host.waitForRestartWriter(owner, execution, lifetime.session, terminal.correlationId,
        () => readRemoteOutputSettlement(owner, execution, proof), signal)
      const configuration = await this.host.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
      const run = await this.host.runs.get(execution.runId, owner)
      if (!configuration || !run) throw new DomainError('NATIVE_SETTLEMENT_UNAVAILABLE', 'The saved execution configuration is unavailable.', 409)
      await this.host.validateContinuation?.(execution.id, signal)
      const request = await this.host.workflowRequest(execution, configuration, run, owner)
      const context = { ...await this.host.managerContext(execution, configuration), workflowRequest: request }
      const resolved = this.host.resolveManager(context, owner)
      if (resolved.processState === 'needs_start') resolved.beginStart?.()
      owned = this.host.lifecycle.ownSession(execution, context, resolved.manager)
      owned.runOwner = owner
      owned.session = lifetime.session
      owned.closureGeneration = lifetime.generation
      owned.closureRegistration = Promise.resolve(lifetime.generation)
      owned.terminalRecoveredWithoutCredential = true
      const attached = await this.host.lifecycle.openingSession(owned, resolved.manager.attachSession(lifetime.session,
        { kind: 'workflow', correlationId: terminal.correlationId, request }, signal))
      this.host.assertSessionIdentity(lifetime.session, attached)
      resolved.markResident?.()
    }
    owned.execution = execution
    const retained = owned
    await retained.manager.withLane(retained.session!, terminal.correlationId, signal,
      (manager, lane) => this.finishOutputSettlement(retained, owner, terminal, manager, lane))
    return true
  }

  private captureNative(owner: RunOwnership, execution: HarnessExecution, source: WorkflowOriginalNativeSource,
    kind: 'live' | 'recovery', lease?: SessionWriteLease): RepeatNativeEvidence {
    const owned = this.host.ownedSessions.get(execution.id)
    if (!owned?.session || owned.consultation || !this.host.nativeCaptures) throw new DomainError('NATIVE_CAPTURE_COMPOSITION_REQUIRED',
      'The original native coordinator capture channel is not composed.', 409)
    const manager = owned.manager, session = owned.session, generation = owned.generation
    const closureGeneration = owned.closureGeneration ?? null
    return this.host.nativeCaptures.capture({ owner, execution, session, manager, source, kind, ...(lease ? { lease } : {}),
      lifetimeGeneration: generation, closureGeneration,
      assertCurrent: () => {
        owner.assertOwned()
        if (this.host.ownedSessions.get(execution.id) !== owned || owned.manager !== manager || owned.session !== session
          || owned.generation !== generation || (owned.closureGeneration ?? null) !== closureGeneration
          || owned.opening || owned.openingFailed || owned.failed || owned.controller.signal.aborted) {
          throw new DomainError('NATIVE_LIFETIME_CHANGED', 'The original native source lost its coordinator lifetime.', 409)
        }
      } })
  }

  /** Permission to observe/attach only the exact accepted session. This capture
   * is not a terminal result, no-submission proof or native acknowledgement. */
  async nativeBoundaryEvidence(executionId: string, owner: RunOwnership): Promise<RepeatNativeEvidence> {
    const execution = await this.host.runs.getExecution(executionId, owner)
    if (!execution) throw new DomainError('EXECUTION_NOT_FOUND', 'The exact execution is unavailable.', 404)
    await this.host.reviewerSessions.recoverRetainedReviewer(execution, owner)
    const owned = this.host.ownedSessions.get(executionId)
    if (owned?.session) {
      owned.runOwner = owner
      this.host.managers.adoptOwner?.(executionId, this.host.rawManagers.get(owned.manager) ?? owned.manager, owner)
      await owned.manager.observeBoundary(owned.session, owned.controller.signal)
    }
    return this.captureNative(owner, execution, { type: 'boundary' }, 'recovery')
  }

  /** The exact ordinary/occurrence attempt is already admitted.
   * Completed re-entry has no request/configuration/preflight/native-start path. */
  async observeExact(input: Omit<ApprovalObservationInput, 'candidate' | 'request'> & {
    execution: HarnessExecution; request?: HarnessExecutionRequest; store: RepeatNativeObservationStore
  }): Promise<ApprovalExecutionObservation> {
    input.signal.throwIfAborted()
    input.owner.assertOwned()
    const { execution } = await input.store.readExecution(input.execution.id)
    assertSameRepeatExecution(input.execution, execution)
    if (execution.runId !== input.owner.runId || input.graphThreadId !== execution.runId) {
      throw new DomainError('GRAPH_SCOPE_MISMATCH', 'Native observation cannot cross Run owners or checkpoints.', 409)
    }
    if (execution.state === 'completed') {
      await this.finishRepeatExecution(execution, input.store, input.owner, input.signal)
      return { state: 'completed', execution, result: execution.result! }
    }
    const request = input.request
    if (!request || request.executionId !== execution.id || request.runId !== execution.runId
      || request.workflowNodeId !== execution.workflowNodeId
      || request.configuration.agentId !== execution.agentId
      || request.configuration.id !== execution.agentConfigurationVersionId) {
      throw new DomainError('REPEAT_EXECUTION_INPUT_CONFLICT', 'Native work requires its exact pinned request.', 409)
    }
    await input.store.assertExecutionAdmission(execution.id)
    const claimed = await (await this.host.runs.repeat(input.owner)).claimWorkflowInput(execution.id)
    // The saved chat prompt was composed before this attempt prepared its browser; name the session it owns.
    const browserPrompt = claimed?.nativePrompt ? await this.host.collaboration?.readBrowserPrompt(input.owner, execution) : undefined
    const queuedInput = claimed && browserPrompt ? { ...claimed, nativePrompt: `${claimed.nativePrompt}\n\n${browserPrompt}` } : claimed
    const admittedRequest = appendWorkflowChatInput(request, queuedInput)
    input.signal.throwIfAborted()
    input.owner.assertOwned()
    return withRuntimeTimingContext({ runId: execution.runId, executionId: execution.id }, () =>
      timeRuntimeOperation('engine', 'execution.observe', () => this.observeExecution(
        { ...input, candidate: execution, request: admittedRequest, queuedInput }, { execution, created: false }, input.store)))
  }

  private async observeExecution(input: ApprovalObservationInput,
    ensured: { execution: HarnessExecution; created: boolean }, repeat: RepeatNativeObservationStore): Promise<ApprovalExecutionObservation> {
    const credentialFailure = new AbortController()
    const observation: WorkflowObservationState = {
      input, ensured, repeat, credentialFailure,
      signal: AbortSignal.any([input.signal, credentialFailure.signal]),
      execution: ensured.execution, repeatLaunch: false, nativeTurnOffered: false, workResultRepairs: 0,
      workflowCorrelation: `execution:${ensured.execution.id}`, knownSecrets: [],
      committedNativeSequences: new Map(),
      bookkeeping: work => retryDatabaseTimeout(work, { signal: observation.signal, check: () => input.owner.assertOwned() }),
      validateContinuation: () => observation.bookkeeping(async () => {
        await this.host.validateContinuation?.(observation.execution.id, observation.signal)
      }),
      assertBoundary: async () => {
        observation.signal.throwIfAborted()
        input.owner.assertOwned()
        await observation.bookkeeping(() => repeat.assertNativeBoundary(observation.execution.id))
        observation.signal.throwIfAborted()
        input.owner.assertOwned()
      },
      watchCredential: () => {
        const credential = observation.manager && this.host.credentialLedger.get(observation.manager)
        if (credential) observation.knownSecrets.push(...Object.values(credential.environment.variables))
      },
      safeValue: value => nativePersistenceRedactor(observation.knownSecrets).value(value),
      safeError: error => nativePersistenceRedactor(observation.knownSecrets).error(error),
      startCredentialMaintenance: () => this.startWorkflowCredentialMaintenance(observation),
      observePending: (history, sourceLease) => this.observePendingWorkflowHistory(observation, history, sourceLease),
    }
    observation.signal.throwIfAborted()
    assertNativeWorkflowConfiguration(input.request.configuration.harness, input.approval,
      input.approval?.handler === 'orchestrator'
        && input.request.configuration.agentId === input.approval.designatedOrchestratorAgentId)
    try {
      const completed = await this.prepareWorkflowObservation(observation)
      if (completed) return completed
      const waiting = await this.startWorkflowObservation(observation)
      if (waiting) return waiting
      return await this.reconcileWorkflowObservation(observation)
    } catch (rawError) {
      return await this.failWorkflowObservation(observation, rawError)
    } finally {
      try { await observation.stopRenewal?.() }
      finally {
        if (observation.budgetTimer) clearTimeout(observation.budgetTimer)
        observation.finishStartup?.()
      }
    }
  }

  private startWorkflowCredentialMaintenance(observation: WorkflowObservationState): void {
    const { input } = observation
    observation.watchCredential()
    if (!this.host.credentials || observation.stopRenewal || !observation.manager! || !this.host.credentialLedger.has(observation.manager!)) return
    observation.stopRenewal = renewOwnedLeases({
      signal: observation.signal,
      check: async () => {
        observation.signal.throwIfAborted()
        input.owner.assertOwned()
        await this.host.validateContinuation?.(observation.execution.id, observation.signal)
        input.owner.assertOwned()
      },
      leases: [this.host.credentialLedger.lease(observation.manager!, async () => {
        const credential = this.host.credentialLedger.get(observation.manager!)
        if (!credential) throw new Error('The execution lost its native credential lease.')
        if (remainingCredentialLifetime(credential) <= WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) {
          await this.host.credentialLedger.renew(observation.manager!, observation.context!.executionId, {
            signal: observation.signal,
            check: async () => {
              observation.signal.throwIfAborted()
              input.owner.assertOwned()
            },
          })
        }
        input.owner.assertOwned()
      })],
      onFailure: (error, phase, lease) => {
        const failure = new DomainError('WORKER_CREDENTIAL_EXPIRING',
          'Execution stopped before its App credential expired. Active native work was not restarted.', 409)
        failure.cause = error
        componentLogger('harness').warn({ operation: 'maintain workflow credential',
          executionId: observation.execution.id, runId: observation.execution.runId, phase, lease,
          remainingMs: remainingCredentialLifetime(this.host.credentialLedger.get(observation.manager!)),
          err: observation.safeError(failure) }, 'Worker credential maintenance failed')
        observation.credentialFailure.abort(failure)
      },
    })
  }

  private async resumeWorkflowBudget(observation: WorkflowObservationState):
    Promise<ApprovalExecutionObservation | undefined> {
    try {
      await observation.bookkeeping(() => this.host.budgets.resume(observation.execution.id))
      return undefined
    } catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'EXECUTION_STOPPED') throw error
      const { input, repeat } = observation
      const saved = await observation.bookkeeping(async () => (await input.owner.oneShotConnection()
        .query<{ failure_result: unknown }>(`select failure_result from approval_execution_state
          where execution_id=$1 and graph_thread_id=$2`, [observation.execution.id, input.owner.runId])).rows[0])
      if (!saved?.failure_result) throw error
      const failure = ExecutionResultSchema.parse(saved.failure_result)
      if (!isTransientExecutionResult(failure)) throw error
      // The budget was stopped before negative settlement committed. Finish that
      // attempt's cleanup before its node can start a replacement.
      await observation.bookkeeping(() => this.host.abandonAttempt(input.owner, observation.execution, failure))
      observation.execution = (await observation.bookkeeping(() => repeat.readExecution(observation.execution.id))).execution
      await this.finishRepeatExecution(observation.execution, repeat, input.owner, observation.signal)
      return { state: 'completed', execution: observation.execution, result: observation.execution.result! }
    }
  }

  private async prepareWorkflowObservation(observation: WorkflowObservationState):
    Promise<ApprovalExecutionObservation | undefined> {
    const { input, repeat } = observation
    observation.signal.throwIfAborted()
    input.owner.assertOwned()
    if (observation.execution.state === 'completed') {
      if (!observation.execution.result) throw new Error('The completed execution has no durable result.')
      await this.finishRepeatExecution(observation.execution, repeat, input.owner, observation.signal)
      return { state: 'completed', execution: observation.execution, result: observation.execution.result }
    }
    await observation.bookkeeping(() => this.host.budgets.ensure(
      observation.execution.id, input.graphThreadId, input.agentActiveTimeoutMs ?? this.host.activeTimeoutMs))
    const settled = await this.resumeWorkflowBudget(observation)
    if (settled) return settled
    if (input.workHandoffContract || input.deliverable) {
      observation.workResultRepairs = await observation.bookkeeping(() => this.host.runs.readWorkResultRepairAttempt(observation.execution.id, input.owner))
      observation.workflowCorrelation = workResultRepairCorrelation(observation.execution.id, observation.workResultRepairs)
    }
    const budgetStarted = performance.now()
    // An exhausted budget found on recovery takes the same deadline path as a
    // live timeout: abort, close the exact session and settle negatively.
    const remainingMs = await observation.bookkeeping(() => this.host.budgets.remaining(observation.execution.id)).catch((error: unknown) => {
      if (error instanceof DomainError && error.code === 'EXECUTION_ACTIVE_TIMEOUT') return 0
      throw error
    })
    const deadline = new AbortController()
    observation.budgetTimer = setTimeout(() => deadline.abort(new DomainError('EXECUTION_ACTIVE_TIMEOUT', 'The execution exhausted its active-time budget.', 409)),
      Math.max(0, remainingMs - (performance.now() - budgetStarted)))
    observation.budgetTimer.unref()
    observation.signal = AbortSignal.any([observation.signal, deadline.signal])
    // Read the durable reference before resolving a manager: a repository
    // failure must not evict a resident session still needed by run cleanup.
    observation.existing = observation.execution.nativeSessionId
      ? await observation.bookkeeping(() => this.host.interactions.getForExecution(observation.execution.id)) : undefined
    observation.request = HarnessExecutionRequestSchema.parse({
      ...input.request, executionId: observation.execution.id, runId: observation.execution.runId,
      workflowNodeId: observation.execution.workflowNodeId, workingDirectory: observation.execution.workingDirectory,
      runtimeDirectory: observation.execution.runtimeDirectory, systemPrompt: observation.execution.systemPrompt, input: observation.execution.input,
    })
    if (observation.request!.systemPrompt === undefined) delete observation.request!.systemPrompt
    observation.context = {
      ...await observation.bookkeeping(() => this.host.managerContext(observation.execution, input.request.configuration)),
      workflowRequest: observation.request!,
    }
    await observation.validateContinuation()
    {
      await observation.bookkeeping(() => repeat.assertExecutionAdmission(observation.execution.id))
      // Resolving this manager constructs an object only. Native preflight
      // is fenced below, AFTER its durable lifetime registration commits.
      if (observation.execution.nativeSessionId) {
        observation.session = await observation.bookkeeping(() => repeat.exactSession(observation.execution.id))
        if (observation.session!.harness !== observation.context!.harness || observation.session!.nativeSessionId !== observation.execution.nativeSessionId) {
          throw new DomainError('NATIVE_SESSION_IDENTITY_MISMATCH', 'Recovery changed the captured native session.', 409)
        }
      }
      const resident = this.host.ownedSessions.get(observation.execution.id)
      if (resident) {
        assertSameRepeatExecution(observation.execution, resident.execution)
        if (resident.context.purpose === 'reviewer' || resident.cleanup || resident.reviewFinishing) {
          throw new DomainError('SESSION_LANE_BUSY', 'The exact native lifetime is finishing other work.', 409)
        }
        if (resident.session && observation.session!) this.host.assertSessionIdentity(resident.session, observation.session!)
      }
      if (!resident && observation.session!) {
        const continuing = observation.context!.acceptedPlacement?.hostRef.kind === 'device'
          ? await observation.bookkeeping(() => readRemoteWorkflowContinuation(input.owner, observation.execution)) : undefined
        const detached = continuing ? undefined : await this.host.detachedWorkflowSession(input.owner, observation.execution)
        if (continuing || detached) {
          this.host.assertSessionIdentity(continuing?.session ?? detached!, observation.session!)
          const recovery = continuing ?? await readDetachedWorkflowLifetime(input.owner, observation.execution)
          if (recovery) observation.restartRecovery = { ...recovery, owner: input.owner }
          await this.host.waitForRestartWriter(input.owner, observation.execution, observation.session!, observation.workflowCorrelation, continuing
            ? () => readRemoteWorkflowContinuation(input.owner, observation.execution)
            : () => readDetachedWorkflowLifetime(input.owner, observation.execution), observation.signal)
        }
      }
    }
    observation.resolved = this.host.resolveManager(observation.context!, input.owner)
    if (observation.resolved!.processState === 'needs_start') observation.resolved!.beginStart?.()
    observation.manager = observation.resolved!.manager
    observation.ownedSession = this.host.lifecycle.ownSession(observation.execution, observation.context!, observation.manager!)
    observation.ownedSession!.runOwner = input.owner
    observation.ownedSession!.activeSessionMode = input.queuedInput?.request.sessionMode ?? 'regular'
    await observation.ownedSession!.stopWaitingRenewal?.()
    delete observation.ownedSession!.stopWaitingRenewal
    if (observation.restartRecovery) observation.ownedSession!.restartRecovery ??= observation.restartRecovery
    if (observation.session! && !observation.ownedSession!.session) observation.ownedSession!.session = observation.session!
    if (observation.session! && (observation.context!.acceptedPlacement?.hostRef.kind === 'device'
      || observation.context!.harness === 'codex' && !observation.context!.purpose)) {
      observation.ownedSession!.restartAttachment = { session: observation.session!, request: observation.request! }
    }
    observation.signal = AbortSignal.any([observation.signal, observation.ownedSession!.controller.signal])
    if (!observation.execution.nativeSessionId) {
      observation.ownedSession!.starting = new Promise<void>((resolve) => { observation.finishStartup = resolve })
    }
  }

  private async observePendingWorkflowHistory(observation: WorkflowObservationState, history: NativeHistory,
    sourceLease?: WorkflowNativeLease): Promise<ApprovalExecutionObservation | undefined> {
    const manager = observation.manager!
    const ownedSession = observation.ownedSession!
    const session = observation.session!
    const { input, repeat } = observation
    observation.signal.throwIfAborted()
    input.owner.assertOwned()
    if (!history.pendingInteractions.length) return undefined
    const originalHistory = this.captureNative(input.owner, observation.execution,
      { type: 'history', history: observation.safeValue(history) }, sourceLease?.live ? 'live' : 'recovery',
      manager.capturedLease(session))
    history = { ...history, events: history.events.map((event) => normalizeNativeProducerEvent(
      observation.safeValue({ ...event, executionId: observation.execution.id })).event) }
    observation.signal.throwIfAborted()
    input.owner.assertOwned()
    const pendingExecution = HarnessExecutionSchema.parse({ ...observation.execution, state: 'waiting' })
    await observation.bookkeeping(() => this.host.runs.updateExecution(pendingExecution, input.owner, originalHistory))
    observation.execution = (await observation.bookkeeping(() => repeat.readExecution(pendingExecution.id))).execution
    ownedSession.execution = observation.execution
    const waiting: DurableInteraction[] = []
    for (const pending of history.pendingInteractions) {
      const interaction = await observation.bookkeeping(() => this.host.interactions.getNativeRequest(observation.execution.id, session.harness,
        session.nativeSessionId, pending.turn.nativeRequestId!))
      if (!interaction) throw new DomainError('APPROVAL_ORIGINAL_SOURCE_REQUIRED',
        'The owned native request publication did not commit.', 409)
      if (interaction.deliveryState !== 'delivered') waiting.push(interaction)
      await this.host.enqueueReview(interaction)
    }
    if (!waiting.length) return undefined
    observation.signal.throwIfAborted()
    this.host.maintainWaitingWorkflowCredential(ownedSession)
    return { state: 'waiting', execution: observation.execution, interaction: waiting[0]!, interactions: waiting }
  }

  private async startWorkflowObservation(observation: WorkflowObservationState):
    Promise<ApprovalExecutionObservation | undefined> {
    const context = observation.context!
    const manager = observation.manager!
    const resolved = observation.resolved!
    const ownedSession = observation.ownedSession!
    const request = observation.request!
    const { input, repeat } = observation
    if (!observation.execution.nativeSessionId) {
      const launchContext = context
      const launchManager = resolved
      const environment = await timeRuntimeOperation('harness', 'native.prepare_environment', () =>
        this.host.prepareEnvironment(launchContext, launchManager, { signal: observation.signal, enterNative: async () => {
          await repeat.authorizeNativeSubmission(observation.execution.id)
          observation.repeatLaunch = repeat.consumeLaunch(observation.execution.id)
          if (!observation.repeatLaunch) throw new DomainError('NATIVE_SESSION_START_UNCERTAIN',
            'No exact committed launch permit exists. Native work was not started.', 409)
        } }))
      observation.startCredentialMaintenance()
      await observation.validateContinuation()
      observation.signal.throwIfAborted()
      input.owner.assertOwned()
      await observation.assertBoundary()
      const start = { request, correlationId: observation.workflowCorrelation, ...(environment ? { environment } : {}),
        ...(observation.execution.sessionContinuation ? { sessionContinuation: observation.execution.sessionContinuation } : {}) }
      const persistObservedSession = async (observed: NativeSessionReference, setupLane?: SessionWriteLease) => {
        if (observed.harness !== context.harness) throw new Error('The observed native session has the wrong harness.')
        observation.session = observed
        resolved.markResident?.()
        const createdEvidence = this.captureNative(input.owner, observation.execution, { type: 'session_created', session: observed }, 'live', setupLane ?? manager.capturedLease(observed))
        observation.execution = HarnessExecutionSchema.parse({ ...observation.execution, nativeSessionId: observed.nativeSessionId, state: 'running' })
        await observation.bookkeeping(async () => {
          await this.host.runs.updateExecution(observation.execution, input.owner, createdEvidence)
          ownedSession.execution = observation.execution
        })
        await observation.validateContinuation()
        observation.signal.throwIfAborted()
        input.owner.assertOwned()
        await observation.assertBoundary()
      }
      const publishObservedSession = async (observed: NativeSessionReference) => {
        const active = manager.capturedLease(observed)
        if (!context.acceptedPlacement || active) {
          await persistObservedSession(observed, active)
          input.onStarted?.()
          return
        }
        // Actual source continuation needs the original native owner and a
        // live lane during publication/revalidation before its first turn.
        const correlationId = observation.workflowCorrelation
        await manager.withLane(observed, correlationId, observation.signal, async (native, lane) => {
          await manager.requireIdle(native, observed, correlationId, lane, observation.signal)
          await this.host.interactions.coordination.bindLaneTurn(lane.fence, correlationId)
          return persistObservedSession(observed, lane)
        })
        input.onStarted?.()
      }
      const nativeSchema = input.deliverable ? nativeOutputSchema(input.deliverable) : undefined
      let nativeEvents: AsyncIterable<NativeHarnessEvent[]>
      let rejectObserved: ((error: unknown) => void) | undefined
      try {
        if (manager.startInitialTurnBatches && !observation.execution.sessionContinuation) {
          let resolveObserved!: (observed: NativeSessionReference) => void
          const observed = new Promise<NativeSessionReference>((resolve, reject) => { resolveObserved = resolve; rejectObserved = reject })
          const opening = this.host.lifecycle.openingSession(ownedSession, observed)
          void opening.catch(() => {
            // ignore: the owned-session lifecycle joins this opening promise during cleanup.
          })
          nativeEvents = manager.startInitialTurnBatches(start, {
            prompt: observation.input.queuedInput?.nativePrompt ?? buildHarnessPrompt(request), clientCorrelationId: observation.workflowCorrelation,
            ...(input.queuedInput?.request.sessionMode ? { sessionMode: input.queuedInput.request.sessionMode } : {}),
            deferSettlement: true,
            ...(nativeSchema ? { outputSchema: nativeSchema } : {}),
            onTurnOffered: () => { observation.nativeTurnOffered = true },
            onSessionObserved: async (native) => {
              resolveObserved(native)
              await publishObservedSession(await opening)
            },
          }, observation.signal)
        } else {
          const observed = await this.host.lifecycle.openingSession(ownedSession,
            timeRuntimeOperation('harness', 'native.create_session', () => manager.createSession(start, observation.signal)))
          nativeEvents = manager.startTurnBatches(observed, {
            prompt: observation.input.queuedInput?.nativePrompt ?? buildHarnessPrompt(request), clientCorrelationId: observation.workflowCorrelation,
            ...(input.queuedInput?.request.sessionMode ? { sessionMode: input.queuedInput.request.sessionMode } : {}),
            deferSettlement: true,
            ...(nativeSchema ? { outputSchema: nativeSchema } : {}),
            onSessionReady: () => publishObservedSession(observed),
            onTurnOffered: () => { observation.nativeTurnOffered = true },
          }, observation.signal)
        }
        let nativeEventsPersisted = false
        for await (const events of nativeEvents) {
          observation.signal.throwIfAborted()
          await observation.bookkeeping(() => this.host.budgets.assertActive(observation.execution.id))
          const lease = manager.currentProjectionLease(observation.session!)
          const frames = events.map((event) => {
            const original = observation.safeValue({ ...event, executionId: observation.execution.id })
            return { event: original, evidence: this.captureNative(input.owner, observation.execution,
              { type: 'event', event: original }, 'live', manager.capturedLease(observation.session!)) }
          })
          await timeRuntimeOperation('engine', 'native.persist_batch', async () => {
            const append = () => this.host.runs.appendNativeEvents(frames, input.owner, lease)
            if (nativeEventsPersisted) return observation.bookkeeping(append)
            // An unconfirmed first journal write yields to recovery of the original submission.
            try {
              await append()
              nativeEventsPersisted = true
            } catch (cause) {
              if (!isDatabaseTimeout(cause)) throw cause
              const error = new DomainError('NATIVE_PUBLICATION_UNCERTAIN',
                'The first native event publication could not be confirmed.', 409)
              error.cause = cause
              throw error
            }
          }, { count: frames.length })
          for (const { event } of frames) this.recordCommittedNativeEvent(observation, event)
          observation.finishStartup?.()
          const history = await manager.history(observation.session!, observation.signal)
          const waiting = await observation.observePending(history, lease)
          if (waiting) return waiting
          // Commit bounded frames while their writer lease remains held.
        }
      } catch (error) { rejectObserved?.(error); throw error }
      finally { if (!observation.session!) rejectObserved?.(new Error('Initial input has no observed native session.')) }

    } else {
      if (!observation.session!) throw new DomainError('NATIVE_SESSION_IDENTITY_MISMATCH', 'Recovery requires the exact saved session.', 409)
      ownedSession.session = observation.session!
      if (observation.existing) this.host.assertSessionIdentity(observation.session!, observation.existing)
      const environment = await this.host.prepareEnvironment(context, resolved, { signal: observation.signal, restartOwner: input.owner })
      observation.startCredentialMaintenance()
      await observation.validateContinuation()
      observation.signal.throwIfAborted()
      input.owner.assertOwned()
      await observation.assertBoundary()
      if (resolved.processState === 'needs_start') {
        const attached = await this.host.lifecycle.openingSession(ownedSession, manager.attachSession(observation.session!, {
          kind: 'workflow', correlationId: observation.workflowCorrelation, request,
          ...(environment ? { environment } : {}),
        }, observation.signal))
        this.host.assertSessionIdentity(observation.session!, attached)
        resolved.markResident?.()
      }
      // Resident sessions retain their original scoped process credentials.
      // history() below verifies the already-owned exact session, without a
      // redundant attachSession() requiring a newly supplied environment.
      input.onStarted?.()
    }
  }

  private recordCommittedNativeEvent(observation: WorkflowObservationState, event: NativeHarnessEvent): void {
    const connection = event.connectionId ?? ''
    const previous = observation.committedNativeSequences.get(connection) ?? -1
    observation.committedNativeSequences.set(connection, Math.max(previous, event.sequence))
  }

  private async publishRecoveredNativeEvents(observation: WorkflowObservationState, events: readonly NativeHarnessEvent[],
    lane: SessionWriteLease, lease: WorkflowNativeLease): Promise<boolean> {
    const pending = events.filter(event => event.sequence
      > (observation.committedNativeSequences.get(event.connectionId ?? '') ?? -1))
    for (let offset = 0; offset < pending.length; offset += NATIVE_EVENT_BATCH_SIZE) {
      await lane.guard.check()
      const frames = pending.slice(offset, offset + NATIVE_EVENT_BATCH_SIZE).map(event => {
        const original = observation.safeValue({ ...event, executionId: observation.execution.id })
        return { event: original, evidence: this.captureNative(observation.input.owner, observation.execution,
          { type: 'event', event: original }, 'recovery', lane) }
      })
      await observation.bookkeeping(() => this.host.runs.appendNativeEvents(frames, observation.input.owner, lease))
      for (const { event } of frames) this.recordCommittedNativeEvent(observation, event)
    }
    return pending.length > 0
  }

  private async correctWorkflowResult(observation: WorkflowObservationState,
    nativeManager: NativeHarnessSessionManager, lane: SessionWriteLease, observed: NativeHistory,
    captured: RepeatNativeEvidence, repairPrompt: string): Promise<
      { kind: 'unavailable' | 'repaired' } | { kind: 'waiting'; observation: ApprovalExecutionObservation }> {
    if (observation.workResultRepairs >= 2) return { kind: 'unavailable' }
    const { input } = observation
    assertOriginalWorkflowTerminal(observation.execution, observation.session!, observed, observation.workflowCorrelation)
    const reserved = await observation.bookkeeping(() => this.host.runs.reserveWorkResultRepair(
      observation.execution.id, observed.terminalTurn!.providerId, input.owner, captured))
    if (!reserved) return { kind: 'unavailable' }
    observation.workResultRepairs = reserved
    await observation.validateContinuation()
    await observation.assertBoundary()
    await lane.guard.check()
    const idle = reviewTurnEvidence(observation.session!, observed, observation.workflowCorrelation, lane.providerId)
    if (!idle.nativeIdle || idle.nativeBusy || idle.identityConflict) throw new DomainError(
      'SESSION_LANE_BUSY', 'The native session has active or unreconciled work.', 409)
    observation.workflowCorrelation = workResultRepairCorrelation(observation.execution.id, reserved)
    await this.host.interactions.coordination.bindLaneTurn(lane.fence, observation.workflowCorrelation)
    lane.correlationId = observation.workflowCorrelation
    delete lane.providerId
    lane.observedStatus = 'uncertain'
    const acknowledge = async (providerId: string) => {
      await lane.guard.check()
      await observation.bookkeeping(() => this.host.interactions.coordination.acknowledgeLaneTurn(
        lane.fence, observation.workflowCorrelation, providerId))
      lane.providerId = providerId
    }
    const nativeSchema = input.deliverable ? nativeOutputSchema(input.deliverable) : undefined
    const events = nativeManager.startTurn(observation.session!, {
      prompt: repairPrompt, ...(nativeSchema ? { outputSchema: nativeSchema } : {}),
      clientCorrelationId: observation.workflowCorrelation, deferSettlement: true,
      onSubmitted: acknowledge,
      onMessageSubmitted: async receipt => {
        if (receipt.nativeSessionId !== observation.session!.nativeSessionId
          || receipt.clientCorrelationId !== observation.workflowCorrelation) throw new DomainError(
            'NATIVE_MESSAGE_IDENTITY_CONFLICT', 'The corrective message differs from the owned session.', 409)
        await acknowledge(receipt.nativeMessageId)
      },
    }, lane.guard.signal)
    for await (const event of events) {
      await lane.guard.check()
      await observation.bookkeeping(() => this.host.budgets.assertActive(observation.execution.id))
      const original = observation.safeValue({ ...event, executionId: observation.execution.id })
      const evidence = this.captureNative(input.owner, observation.execution, { type: 'event', event: original }, 'live', lane)
      await observation.bookkeeping(() => this.host.runs.appendNativeEvent(original, input.owner,
        { ...lane.fence, ...(lane.providerId ? { providerId: lane.providerId } : {}), live: true },
        undefined, undefined, evidence))
      this.recordCommittedNativeEvent(observation, original)
      const history = await nativeManager.history(observation.session!, lane.guard.signal)
      const waiting = await observation.observePending(history,
        { ...lane.fence, ...(lane.providerId ? { providerId: lane.providerId } : {}), live: true })
      if (waiting) return { kind: 'waiting', observation: waiting }
    }
    return { kind: 'repaired' }
  }

  /** A marked terminal commits native evidence and F1 together while the
   * original session is still eligible for correction. Only after COMMIT does
   * this finalize that original provider result and its physical artifacts. */
  private async publishCommittedTerminalSettlement(execution: HarnessExecution, owner: RunOwnership,
    session: NativeSessionReference, nativeManager: NativeHarnessSessionManager, lane: SessionWriteLease,
    original: NonNullable<Awaited<ReturnType<PostgresRunRepository['readWorkflowTerminalSettlement']>>>,
    observed?: NativeHistory): Promise<void> {
    await lane.guard.check()
    owner.assertOwned()
    const owned = this.host.ownedSessions.get(execution.id)
    const safe = nativePersistenceRedactor(owned ? this.host.credentialLedger.secrets(owned.manager) : [])
    const history = safe.value(observed ?? await nativeManager.reconcile(session, original.correlationId, lane.guard.signal))
    assertOriginalWorkflowTerminal(execution, session, history, original.correlationId)
    if (!isDeepStrictEqual(history.terminalTurn!.result, original.nativeResult)) throw new DomainError(
      'NATIVE_TERMINAL_SOURCE_REQUIRED', 'Settlement differs from the already committed original result.', 409)
    lane.providerId = history.terminalTurn!.providerId
    await this.host.interactions.coordination.acknowledgeLaneTurn(lane.fence, original.correlationId, lane.providerId)
    const settled = nativeManager.settleTurn
      ? safe.value(await nativeManager.settleTurn(session, original.correlationId, lane.guard.signal)) : history
    assertOriginalWorkflowTerminal(execution, session, settled, original.correlationId)
    if (!isDeepStrictEqual(settled.terminalTurn, history.terminalTurn)) throw new DomainError(
      'NATIVE_TERMINAL_SOURCE_REQUIRED', 'The settled result differs from the original committed provider output.', 409)
    const captured = this.captureNative(owner, execution,
      { type: 'history', history: settled }, 'recovery', lane)
    await this.host.runs.publishWorkflowTerminalSettlement(execution, owner, captured)
    if (owned) owned.outputSettlementComplete = true
    await lane.guard.check()
  }

  private async settleRetainedWorkflowTerminal(execution: HarnessExecution, owner: RunOwnership,
    signal: AbortSignal): Promise<void> {
    const owned = this.host.ownedSessions.get(execution.id)
    // Cold cleanup uses the existing owner/process/artifact recovery path. A
    // completed execution must never attach or create a replacement manager.
    if (!owned?.session || owned.context.purpose === 'reviewer') return
    const original = await this.host.runs.readWorkflowTerminalSettlement(execution, owner)
    if (!original) return
    owned.execution = execution
    await owned.manager.withLane(owned.session, original.correlationId, signal, async (nativeManager, lane) => {
      await this.publishCommittedTerminalSettlement(execution, owner, owned.session!, nativeManager, lane, original)
    })
  }

  private async reconcileWorkflowObservation(observation: WorkflowObservationState): Promise<ApprovalExecutionObservation> {
    const manager = observation.manager!
    const ownedSession = observation.ownedSession!
    const { input, repeat } = observation
    if (!observation.session) throw new DomainError('NATIVE_SESSION_IDENTITY_REQUIRED', 'Initial input has no observed session identity.', 409)
    const observed = await manager.withLane(observation.session!, observation.workflowCorrelation, observation.signal, async (nativeManager, lane) => {
      let idleDelayMs = 100
      let pendingBoardError: MemoryResultRejected | undefined
      for (;;) {
        let publishedEvents = false
        lane.guard.signal.throwIfAborted()
        input.owner.assertOwned()
        await observation.bookkeeping(() => this.host.budgets.assertActive(observation.execution.id))
        const observed = await timeRuntimeOperation('harness', 'native.reconcile',
          () => nativeManager.reconcile(observation.session!, observation.workflowCorrelation, lane.guard.signal))
        const messageReceipt = observed.nativeSubmission
        const messageIdentity = messageReceipt?.kind === 'message' && messageReceipt.nativeSessionId === observation.session!.nativeSessionId
          && messageReceipt.clientCorrelationId === observation.workflowCorrelation
        let providerId = observed.nativeTurnId
        if (observation.session!.harness === 'claude') {
          providerId = messageIdentity ? messageReceipt.nativeMessageId : undefined
        }
        const exactTerminal = observed.terminalTurn?.correlationId === observation.workflowCorrelation
          && observed.correlationId === observation.workflowCorrelation && Boolean(providerId)
          && observed.terminalTurn.providerId === providerId
          && !observed.pendingInteraction && observed.pendingInteractions.length === 0
        if (exactTerminal) {
          lane.providerId = observed.terminalTurn!.providerId
        } else if (observed.correlationId === observation.workflowCorrelation && providerId) {
          lane.providerId = providerId
        }
        if (lane.providerId) {
          await observation.bookkeeping(() => this.host.interactions.coordination.acknowledgeLaneTurn(
            lane.fence, observation.workflowCorrelation, lane.providerId!,
          ))
        }
        const lease = { ...lane.fence, ...(lane.providerId ? { providerId: lane.providerId } : {}), live: false as const }
        const captured = this.captureNative(input.owner, observation.execution,
          { type: 'history', history: observation.safeValue(observed) }, 'recovery', lane)
        const waiting = await observation.observePending(observed, lease)
        if (waiting) return { waiting }
        if (exactTerminal) {
          const handoffPrompt = input.workHandoffContract
            ? workResultRepairPrompt(observed.terminalTurn!.result, input.workHandoffContract, observation.execution.input,
              input.request?.executionContext, input.coordinationResult, input.hierarchyResult)
            : undefined
          // The deliverable is judged once the handoff envelope itself is valid.
          const verdict = input.deliverable && !handoffPrompt
            ? await observation.bookkeeping(() => deliverableVerdict(observed.terminalTurn!.result, input.deliverable!)) : undefined
          let boardError: MemoryResultRejected | undefined = pendingBoardError
          pendingBoardError = undefined
          if (!handoffPrompt && !verdict && !boardError && observation.execution.resultProtocol) {
            try {
              await observation.bookkeeping(() => this.host.runs.validateMemoryResult(
                observation.execution.id, observed.terminalTurn!.result, input.owner))
            } catch (error) {
              if (!(error instanceof MemoryResultRejected)) throw error
              boardError = error
            }
          }
          const boardPrompt = boardError ? [
            'Your board result could not be applied.', `${boardError.code}: ${boardError.message}`,
            ...(boardError.details ? [`Current state: ${JSON.stringify(boardError.details)}`] : []),
            'Return the complete corrected result. Preserve the deliverable and already committed tool changes.',
            'Correct only the remaining board changes. Do not repeat the task or external work.',
          ].join('\n') : undefined
          const formatPrompt = handoffPrompt ?? (verdict ? deliverableRepairPrompt(verdict, input.deliverable!.outputSchema) : boardPrompt)
          // Ask once when this writable Agent did not update its own Kanban card.
          const missingCardId = observation.workResultRepairs === 0 ? await observation.bookkeeping(() =>
            this.host.runs.kanbanRecordMissing(observation.execution.id, observed.terminalTurn!.result, input.owner)) : undefined
          const kanbanPrompt = missingCardId ? KANBAN_FOLLOW_UP(missingCardId) : undefined
          const repairPrompt = formatPrompt && kanbanPrompt ? `${formatPrompt}\n\n${kanbanPrompt}` : formatPrompt ?? kanbanPrompt
          if (repairPrompt) {
            const repaired = await this.correctWorkflowResult(observation, nativeManager, lane, observed, captured, repairPrompt)
            if (repaired.kind === 'waiting') return { waiting: repaired.observation }
            if (repaired.kind === 'repaired') continue
          }
          if (boardError) throw new HarnessExecutionError('MEMORY_RESULT_INVALID', boardError.message, false)
          // The native result stays the evidence; a deliverable still failing after repair is failed where the terminal is normalized.
          const completed = HarnessExecutionSchema.parse({ ...observation.execution, state: 'completed',
            result: observation.safeValue(observed.terminalTurn!.result), finishedAt: capturedWorkflowNativeTime(captured) })
          observation.signal.throwIfAborted()
          try {
            await timeRuntimeOperation('engine', 'execution.accept_terminal',
              () => observation.bookkeeping(() => this.host.runs.updateExecution(completed, input.owner, captured)))
          } catch (error) {
            if (error instanceof MemoryResultRejected) {
              if (observation.workResultRepairs >= 2) throw error
              pendingBoardError = error
              continue
            }
            if (!isWorkflowResultEffectFailure(error)) throw error
            // The entire terminal transaction rolled back. This is the same
            // original session and the same bounded repair budget as RESULT
            // correction; no successful execution is reopened or rewritten.
            if (observation.workResultRepairs < 2) {
              const prompt = await this.host.collaboration?.effectRepairPrompt(input.owner, error)
              if (!prompt) throw error
              const repaired = await this.correctWorkflowResult(observation, nativeManager, lane, observed, captured, prompt)
              if (repaired.kind === 'waiting') return { waiting: repaired.observation }
              if (repaired.kind === 'repaired') continue
              throw error
            }
            await observation.bookkeeping(() => this.host.runs.updateExecution(completed, input.owner, captured, error))
          }
          // Only committed terminal publication ends credential renewal. A
          // rolled-back board effect must retain authority for its correction.
          await observation.stopRenewal?.()
          // Read the first-terminal normalizer's immutable result, not a local
          // copy of unvalidated provider output. The original remains private.
          observation.execution = (await observation.bookkeeping(() => repeat.readExecution(observation.execution.id))).execution
          ownedSession.execution = observation.execution
          if (input.coordinationResult) {
            const original = await observation.bookkeeping(() =>
              this.host.runs.readWorkflowTerminalSettlement(observation.execution, input.owner))
            if (original) await this.publishCommittedTerminalSettlement(observation.execution, input.owner,
              observation.session!, nativeManager, lane, original, observed)
          } else if (nativeManager.settleTurn) {
            await this.finishOutputSettlement(ownedSession, input.owner, observed.terminalTurn!, nativeManager, lane)
          }
        } else {
          publishedEvents = await this.publishRecoveredNativeEvents(observation, observed.events, lane, lease)
        }
        if (exactTerminal) return { waiting: undefined }
        if (publishedEvents) idleDelayMs = 100
        await timeRuntimeOperation('engine', 'execution.backoff',
          () => delay(idleDelayMs, undefined, { signal: lane.guard.signal }), { intervalMs: idleDelayMs })
        idleDelayMs = Math.min(1000, idleDelayMs * 2)
      }
    })
    const { waiting } = observed
    if (waiting) return waiting
    observation.execution = (await observation.bookkeeping(() => repeat.readExecution(observation.execution.id))).execution
    assertSameRepeatExecution(observation.ensured.execution, observation.execution)
    if (observation.execution.state !== 'completed' || !observation.execution.result || !observation.execution.finishedAt) throw new DomainError(
      'REPEAT_BOUNDARY_PENDING', 'The exact original native terminal has not committed.', 409)
    ownedSession.execution = observation.execution
    await timeRuntimeOperation('engine', 'execution.settle',
      () => this.finishRepeatExecution(observation.execution, repeat, input.owner, observation.signal))
    return { state: 'completed', execution: observation.execution, result: observation.execution.result }
  }

  private async failWorkflowObservation(observation: WorkflowObservationState, rawError: unknown): Promise<never> {
    const { input, repeat } = observation
    // A credential may have been issued just before an abort rejected setup.
    const credential = observation.manager! && this.host.credentialLedger.get(observation.manager!)
    if (credential) observation.knownSecrets.push(...Object.values(credential.environment.variables))
    const error = observation.safeError(observation.signal.aborted && observation.signal.reason instanceof DomainError
      && ['WORKER_CREDENTIAL_EXPIRING', 'EXECUTION_ACTIVE_TIMEOUT'].includes(observation.signal.reason.code)
      ? observation.signal.reason : rawError)
    let code: string | null = error instanceof Error ? error.constructor.name : typeof error
    if (error instanceof DomainError) code = error.code
    else if (rawError instanceof HarnessExecutionError) {
      code = rawError.result.outcome === 'failed' ? rawError.result.error?.code ?? null : rawError.result.outcome
    }
    // Codes only: provider messages may carry model content or secrets.
    componentLogger('engine').warn({ executionId: observation.execution.id, aborted: observation.signal.aborted,
      code,
      reason: error instanceof DomainError && typeof (error.details as { reason?: unknown } | undefined)?.reason === 'string'
        ? (error.details as { reason: string }).reason : undefined,
      // Source locations only (no message text) so unclassified failures stay diagnosable.
      at: rawError instanceof Error && !(rawError instanceof DomainError) ? (rawError.stack ?? '').split('\n')
        .filter(line => line.trimStart().startsWith('at ')).slice(0, 4)
        .map(line => line.replace(/^.*?(\/dist\/|\/src\/)/, '').replace(/[()]/g, '').trim()) : undefined },
    'Workflow native execution failed')
    if (observation.execution.state === 'completed' && !observation.signal.aborted) {
      input.owner.assertOwned()
      throw error
    }
    if (!observation.signal.aborted && error instanceof HarnessExecutionError
      && error.result.error?.code === 'CODEX_OBSERVER_UNAVAILABLE') {
      input.owner.assertOwned()
      throw new DomainError('CODEX_OBSERVER_UNAVAILABLE', error.message, 503)
    }
    if (error instanceof DomainError && error.code === 'APPROVAL_SETTLEMENT_PENDING' && !observation.signal.aborted) {
      input.owner.assertOwned()
      // Waiting for durable proof is not active model time or a reason to
      // close the requester/credential needed by the exact delivery retry.
      try { await this.host.budgets.beginWait(observation.execution.id) }
      catch {
        input.owner.assertOwned()
        throw new DomainError('APPROVAL_SETTLEMENT_PENDING',
          'Exact approval settlement is pending and its budget pause could not be confirmed. Reconcile the same execution; no native work was replayed.', 409)
      }
      input.owner.assertOwned()
      throw error
    }
    // A created session with no offered turn cannot recover by observing a turn.
    // Close its original manager before recording failure; possible submissions remain recoverable.
    const sessionWithoutTurn = observation.repeatLaunch && observation.ownedSession?.session && !observation.nativeTurnOffered
    const activeTimeout = error instanceof DomainError && error.code === 'EXECUTION_ACTIVE_TIMEOUT'
    // A persisted budget check can detect expiry before the deadline timer fires.
    // Only a non-waiting attempt is abandoned for a transient failure; a waiting one is recovered, never fenced for it.
    if (!observation.signal.aborted && !activeTimeout && !(rawError instanceof HarnessExecutionError)
      && !sessionWithoutTurn && !(isTransientExecutionError(error) && observation.execution.state !== 'waiting')) {
      input.owner.assertOwned()
      if (repeatPhysicalSettlementPending(error)) await this.host.budgets.beginWait(observation.execution.id)
      input.owner.assertOwned()
      throw error
    }
    if ((observation.resolved! && !observation.manager!) || isLeaseLost(rawError)
      || (error instanceof DomainError && error.code === 'SESSION_LANE_BUSY')) throw error
    // Restart's cleanup intent can reject SQL preflight before it observes the abort.
    const restarting = observation.signal.reason instanceof DomainError && observation.signal.reason.code === 'ENGINE_RESTART'
    if (restarting) throw error
    let held = true
    try { input.owner.assertOwned() } catch { held = false }
    if (sessionWithoutTurn && held) {
      const stored = (await repeat.readExecution(observation.execution.id)).execution
      assertSameRepeatExecution(observation.ensured.execution, stored)
      observation.ownedSession!.execution = stored
    }
    if (observation.execution.state === 'completed' && (!observation.ownedSession! || this.host.closedExecutions.has(observation.execution.id))) throw error
    // A transient transport error abandons only this attempt so its node can
    // retry. Any other failure fences the Run, closes the captured manager,
    // then lets the repository prove a negative disposition.
    if (held) {
      let code = 'NATIVE_EXECUTION_FAILED'
      if (error instanceof HarnessExecutionError) code = error.result.error?.code ?? code
      if (error instanceof DomainError) code = error.code
      componentLogger('harness').warn({ executionId: observation.execution.id, code, err: error },
        'Workflow native execution failed before cleanup')
      let failure: ExecutionResult | undefined
      const failedRestartAttachment = observation.restartRecovery && observation.ownedSession?.openingFailed
      if (activeTimeout) {
        failure = { outcome: 'failed', error: { code: error.code, message: error.message, retryable: false } }
      } else if (!observation.signal.aborted && !failedRestartAttachment
        && error instanceof HarnessExecutionError && error.result.error) {
        // A closed transport is a failed observation, not a retryable native terminal.
        failure = { outcome: 'failed', error: { ...error.result.error, retryable: false } }
      }
      const persist = <T>(work: () => Promise<T>) =>
        retryDatabaseTimeout(work, { check: () => input.owner.assertOwned() })
      // A late failure of an attempt that another path abandoned or already settled never affects the Run.
      const abandoned = observation.signal.reason instanceof DomainError && observation.signal.reason.code === 'EXECUTION_ABANDONED'
      if (abandoned || !observation.signal.aborted
        && (await persist(() => repeat.readExecution(observation.execution.id))).execution.state === 'completed') {
        if (observation.ownedSession && !observation.ownedSession.failed) {
          observation.ownedSession.failed = true
          const failures = await this.host.lifecycle.cleanupSession(observation.ownedSession)
          if (failures.length) componentLogger('harness').warn({ executionId: observation.execution.id,
            failures: failures.length }, 'Closing a settled attempt remains unconfirmed')
        }
        throw error
      }
      if (repeatTickIndex(observation.execution.input) !== undefined && !input.signal.aborted) {
        await persist(() => this.host.failIntervalCheck(input.owner, observation.execution, failure))
        throw error
      }
      if (!input.signal.aborted && !activeTimeout && observation.execution.state !== 'waiting'
        && isTransientExecutionError(error)) {
        // Infrastructure failure: close this attempt alone; its node starts a fresh one.
        observation.resolved?.markFailed?.()
        // The stored attempt, not the in-memory copy, which may hold an unpublished session.
        await persist(async () => {
          const execution = (await repeat.readExecution(observation.execution.id)).execution
          const startInterrupted = !execution.nativeSessionId && ['queued', 'starting'].includes(execution.state)
          const fallbackCode = startInterrupted ? 'EXECUTION_START_INTERRUPTED' : 'NATIVE_EXECUTION_FAILED'
          await this.host.abandonAttempt(input.owner, execution, transientExecutionFailure(error, fallbackCode))
        })
        throw error
      }
      await persist(() => this.host.runs.requestCleanup(observation.execution.runId, input.owner, failure,
        failure ? { executionId: observation.execution.id } : undefined))
      if (observation.ownedSession!) {
        observation.resolved?.markFailed?.()
        observation.ownedSession!.failed = true
        const failures = await this.host.lifecycle.cleanupSession(observation.ownedSession!)
        // The caught error may contain provider secrets; retain only its sanitized form.
        if (failures.length) throw new AggregateError(failures, 'Original native closure is still pending.', { cause: error })
      }
      await persist(() => this.host.budgets.stop(observation.execution.id))
      await persist(async () => (await this.host.runs.repeat(input.owner)).settleNegativeExecution(observation.execution.id,
        (await this.host.runs.getRepeatSnapshot(observation.execution.runId, input.owner)).stopRequested))
    } else if (observation.ownedSession!) {
      // An old owner may dispose its own captured transport only. It cannot
      // revoke a successor's credential, budget or execution authority.
      const owned = observation.ownedSession!
      const failures: Error[] = []
      await attemptCleanup(failures, 'close lost-owner transport', async signal => {
        if (owned.session) await this.host.lifecycle.closeWorkflowSession(owned, { restart: true, signal })
        else await owned.manager.dispose(signal)
      }, owned.context.acceptedPlacement?.hostRef.kind === 'device' ? { timeoutMs: deviceRequestTimeoutMs } : {})
      if (!failures.length) await this.forgetLostOwnerSession(owned)
    }
    throw error
  }

  /** The successor owner re-enters through the durable detachment like a restart:
   * a fresh manager attaches the same native session under a new lifetime
   * generation. A resident kept here would replay the detached generation. */
  private async forgetLostOwnerSession(owned: OwnedNativeSession): Promise<void> {
    if (this.host.ownedSessions.get(owned.execution.id) !== owned) return
    await owned.stopWaitingRenewal?.()
    if (this.host.ownedSessions.get(owned.execution.id) !== owned) return
    this.host.ownedSessions.delete(owned.execution.id)
    this.host.credentialLedger.delete(owned.manager)
    this.host.managers.release?.(owned.context, this.host.rawManagers.get(owned.manager) ?? owned.manager, 'released')
  }
}

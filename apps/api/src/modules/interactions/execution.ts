import type { WorkflowVersionCurrent } from '@foreman-code/contracts/current'
import { MemoryResultRejected } from '../collaboration/memoryResultError.js'
import { isDatabaseTimeout, retryDatabaseTimeout } from '../../infrastructure/databaseRetry.js'
import type { ExecutionLimiter } from '../runs/limiter.js'
import { RunExecutionCapacity } from './executionCapacity.js'
import { NativeCredentialLedger } from './nativeCredentialLedger.js'
import { ExecutionSessionLifecycle } from './executionSessionLifecycle.js'
import { ExecutionConsultations } from './executionConsultations.js'
import { ExecutionReviewerSessions } from './executionReviewerSessions.js'
import { ExecutionCancellation } from './executionCancellation.js'
import { isRestartCancellation } from './executionPredicates.js'
import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import { runtimeTimingPoint, timeRuntimeOperation, withRuntimeTimingContext } from '../../infrastructure/runtimeTiming.js'
import { inspectNativeResponse } from '../harnesses/responseAvailability.js'
import { supportsExpectedTurnSteer } from '../harnesses/capabilities.js'
import type { InteractionActivityEvidence } from './activityProjection.js'
import type { ReviewNativeCapture, ReviewNativeCapturePort, ReviewOriginalNativeSource } from './reviewNativeCapture.js'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'

import {
  HarnessExecutionSchema,
  ExecutionResultSchema,
  type DurableInteraction,
  type ExecutionResult,
  type HarnessExecution,
  type HarnessExecutionRequest,
  type WorkflowApprovalConfiguration,
  type AgentConfigurationVersion,
  type NativeSessionReference,
  type NativeHarnessEvent,
  type PendingNativeInteraction,
  type ReviewJob,
  type WorkflowRun,
  type CoordinationResultContext,
  type CoordinatorConsultationBinding,
  HarnessExecutionRequestSchema,
} from '@foreman-code/contracts'
import { remainingCredentialLifetime } from '../access/credentialLifetime.js'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE, WORKER_CREDENTIAL_RENEWAL_WINDOW_MS,
  type IssuedWorkerCredential } from '../access/workerCredentials.js'
import type { NativeHarnessSessionManager, NativeHistory } from '../harnesses/port.js'
import { DomainError } from '../errors.js'
import type { WorkflowCollaborationIntegration } from '../collaboration/workflowIntegration.js'
import type { WorkflowQueuedInput, WorkflowChatTarget, WorkflowChatOwnerPort } from '../collaboration/workflowControlTypes.js'
import { appendWorkflowChatInput } from './workflowChatInput.js'
import { createWorkflowChatOwner, type WorkflowChatNativeCapture } from './workflowChatOwner.js'
import { ReviewerDispatcher } from './reviewer.js'
import { nativePersistenceRedactor } from './nativePersistence.js'
import { workResultRepairPrompt } from './workResultRepair.js'
import { deliverableRepairPrompt, deliverableVerdict, nativeOutputSchema, type DeliverableContract } from './deliverable.js'
import { NATIVE_EVENT_BATCH_SIZE } from './nativeEventBatches.js'
import { assertOriginalWorkflowTerminal } from './workflowTerminalSource.js'
import { workResultRepairCorrelation } from '../runs/workResultRepair.js'
import { KANBAN_FOLLOW_UP } from '../runs/kanbanRecord.js'
import { isWorkflowResultEffectFailure } from '../runs/workflowResultEffectFailure.js'
import { reviewTurnEvidence } from './reviewerEvidence.js'
import type { ReviewCleanupSession, ReviewCredentialMaintenance } from './reviewerRuntime.js'
import { coordinateSessionManager, isLeaseLost, type SingleWriterSessionManager } from './sessionWriter.js'
import { HarnessExecutionError } from '../harnesses/errors.js'
import { assertNativeWorkflowConfiguration } from '../harnesses/nativeWorkflowConfiguration.js'
import { attemptCleanup } from './cleanup.js'
import { deviceRequestTimeoutMs } from '../devices/deviceRequestRetry.js'
import { buildHarnessPrompt } from '../harnesses/prompt.js'
import { isTransientRefreshFailure, renewOwnedLeases } from '../leases/ownerLeases.js'
import { componentLogger } from '../diagnostics/logger.js'
import { isTransientExecutionError, isTransientExecutionResult, transientExecutionFailure } from '../runs/executionRetryPolicy.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import type { RunOwnership } from '../runs/ownership.js'
import { capturedWorkflowNativeTime, type WorkflowNativeCapturePort, type WorkflowOriginalNativeSource } from './workflowNativeCapture.js'
import type { RepeatNativeEvidence } from '../runs/repeatNativeRepository.js'
import type { SessionWriteLease } from './sessionWriter.js'
import type { WorkflowNativeLease } from '../runs/workflowNativeGraph.js'
import { normalizeNativeProducerEvent } from '../run-graph/nativeProducerNormalization.js'
import type { PostgresApprovalBudgetRepository } from './budget.js'
import type { CurrentInteractionRepository as PostgresInteractionRepository } from './current/repository.js'
import type {
  AttachedInteractionSession,
  NativeManagerResolutionContext,
  NativeManagerOwnershipContext,
  NativeSessionManagerResolver,
  ResolvedNativeSessionManager,
} from './runtimePorts.js'
import type { ExecutionCredentialProvider } from '../harnesses/mcpDetection.js'
import { readDetachedWorkflowLifetime, readDetachedWorkflowSession, readRemoteWorkflowContinuation, readRemoteOutputSettlement, type ClosedWorkflowSession, type WorkflowClosureStore } from './workflowClosure.js'
import { finishRecoveredWorkflowCredentials } from './workflowTerminalRecovery.js'
import { assertSavedPendingApprovalOriginalLocked } from './nativeApprovalProof.js'
import { openWorkflowLifecycleLocked } from '../runs/repeatLifecycle.js'
import { workflowExecutionRequest } from '../runs/workflowExecutionRequest.js'
import { readWorkflowTeam } from '../runs/workflowTeamPrompt.js'
import { repeatTickIndex } from '../runs/repeatResolution.js'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { reviewPreflightIdentity } from './reviewPolicy.js'
import type { RepeatReviewerBindings } from './repeatReviewer.js'
import { assertSameRepeatExecution, repeatPhysicalSettlementPending, type RepeatNativeObservationStore } from './repeatObservation.js'
import { isRunInProgress } from '../runs/runState.js'

export type ApprovalExecutionObservation =
  | { state: 'waiting'; execution: HarnessExecution; interaction: DurableInteraction; interactions: DurableInteraction[] }
  | { state: 'completed'; execution: HarnessExecution; result: ExecutionResult }

export interface OwnedNativeSession {
  execution: HarnessExecution
  context: NativeManagerResolutionContext
  manager: SingleWriterSessionManager
  controller: AbortController
  generation: number
  closureGeneration?: string
  closureRegistration?: Promise<string>
  launchReserved?: boolean
  launchReservation?: Promise<void>
  failed?: boolean
  session?: NativeSessionReference
  starting?: Promise<void>
  /** Restart stopped waiting for this startup; it is still in flight. */
  startupPending?: boolean
  opening?: Promise<NativeSessionReference>
  openingFailed?: boolean
  preparing?: Promise<IssuedWorkerCredential['environment'] | undefined>
  // A canceled remote attach can leave the original Worker session running without a Main acknowledgment.
  restartAttachment?: { session: NativeSessionReference; request: HarnessExecutionRequest }
  restartRecovery?: {
    owner: RunOwnership
    session: NativeSessionReference
    generation: string
    attachmentGeneration?: string
    principalId?: string
  }
  terminalRecoveredWithoutCredential?: boolean
  outputSettlementComplete?: boolean
  cleanup?: Promise<Error[]>
  reviewFinalizer?: symbol
  reviewFinishing?: boolean
  reviewOwner?: RunOwnership
  releaseReviewOwner?: () => Promise<void>
  runOwner?: RunOwnership
  stopWaitingRenewal?: () => Promise<void>
  stopReviewerRenewal?: () => Promise<void>
  reviewerRenewal?: Promise<void>
  reviewerRecoveryPending?: boolean
  pendingApprovalRestoration?: boolean
  retainedObservationError?: unknown
  activeSessionMode?: 'regular' | 'plan'
  consultation?: {
    binding: CoordinatorConsultationBinding
    commandId: string
    target: Extract<WorkflowChatTarget, { kind: 'workflow_coordinator' }>
    task?: Promise<void>
    started?: Promise<void>
    credential?: IssuedWorkerCredential
    accessRebindAttempted?: boolean
    previous?: { context: NativeManagerResolutionContext; credential?: IssuedWorkerCredential }
  }
}

interface ApprovalObservationInput {
  candidate: HarnessExecution
  request: HarnessExecutionRequest
  approval?: WorkflowApprovalConfiguration | undefined
  agentActiveTimeoutMs?: number | undefined
  workflowId: string
  graphThreadId: string
  owner: RunOwnership
  signal: AbortSignal
  workHandoffContract?: string | undefined
  coordinationResult?: CoordinationResultContext | undefined
  hierarchyResult?: { version: WorkflowVersionCurrent; workflowNodeId: string } | undefined
  /** Enforced deliverable contract for every workflow Agent execution. */
  deliverable?: DeliverableContract | undefined
  onStarted?: (() => void) | undefined
  queuedInput?: WorkflowQueuedInput | undefined
}

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

/** Native dispatch never began, so the original request must still be pending natively. */
function nativeDispatchNotStarted(interaction: DurableInteraction): boolean {
  return ['not_started', 'pending', 'failed'].includes(interaction.deliveryState)
}

/** What the coordinator works with. Tests may compose only the native ports they exercise. */
export interface ApprovalExecutionDependencies {
  runs: PostgresRunRepository
  interactions: PostgresInteractionRepository
  budgets: PostgresApprovalBudgetRepository
  managers: NativeSessionManagerResolver
  activeTimeoutMs: number
  credentials?: ExecutionCredentialProvider | undefined
  validateContinuation?: (((executionId: string, signal?: AbortSignal) => Promise<void>) & {
    forRestart?(executionId: string): Promise<void>
  }) | undefined
  workflowClosures?: WorkflowClosureStore | undefined
  repeatReviewerBindings?: RepeatReviewerBindings | undefined
  nativeCaptures?: WorkflowNativeCapturePort | undefined
  reviewNativeCaptures?: ReviewNativeCapturePort | undefined
  recoverNativeProcesses?: ((executionId: string, signal: AbortSignal, owner: RunOwnership) => Promise<boolean>) | undefined
  reserveNativeLaunch?: ((executionId: string, manager: NativeHarnessSessionManager,
    consultation?: CoordinatorConsultationBinding) => void | Promise<void>) | undefined
  prepareManagerContext?: ((context: NativeManagerResolutionContext) => Promise<NativeManagerResolutionContext>) | undefined
  commitReviewNative?: ((executionId: string) => Promise<void>) | undefined
  collaboration?: WorkflowCollaborationIntegration | undefined
}

/** Production composes the original native capture, closure, reviewer, credential and continuation ports. */
export type CurrentApprovalExecutionDependencies = ApprovalExecutionDependencies & {
  [Port in 'credentials' | 'validateContinuation' | 'workflowClosures' | 'repeatReviewerBindings' | 'nativeCaptures'
    | 'reviewNativeCaptures']-?: NonNullable<ApprovalExecutionDependencies[Port]>
}

/** Idempotent ensure/observe boundary called first on every LangGraph node entry. */
export class ApprovalExecutionCoordinator {
  readonly credentialLedger: NativeCredentialLedger
  private readonly capacity = new RunExecutionCapacity()

  readonly reviewers: ReviewerDispatcher
  readonly lifecycle: ExecutionSessionLifecycle
  readonly consultations: ExecutionConsultations
  readonly reviewerSessions: ExecutionReviewerSessions
  readonly cancellation: ExecutionCancellation
  get reviewCoordination() { return this.interactions.coordination }
  private readonly writers = new WeakMap<NativeHarnessSessionManager, SingleWriterSessionManager>()
  readonly rawManagers = new WeakMap<NativeHarnessSessionManager, NativeHarnessSessionManager>()
  // A waiting graph has no active task, but still owns its native process.
  readonly ownedSessions = new Map<string, OwnedNativeSession>()
  readonly closedExecutions = new Set<string>()
  // Closure survives the early ownerless Stop pass, but never a new connection.
  readonly closedWorkflowSessions = new Map<string, ClosedWorkflowSession>()
  readonly stoppingRuns = new Set<string>()
  readonly pendingCleanupRuns = new Set<string>()
  private readonly sharedRunOwners = new Map<string, RunOwnership>()
  workflowControls: ReturnType<typeof createWorkflowChatOwner> | undefined
  closing = false

  executionCapacity(runId: string, maximum: number): ExecutionLimiter { return this.capacity.limiter(runId, maximum) }

  residentRunIds(): string[] {
    return [...new Set([...this.pendingCleanupRuns, ...[...this.ownedSessions.values()].map((owned) => owned.execution.runId)])]
  }

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
    const retained = this.ownedSessions.get(execution.id)
    const control = await (await this.runs.repeat(owner)).workflowControlDisposition(execution.id)
    if (retained?.manager.retainsReviewerSession && !retained.consultation && control.kind === 'ordinary') {
      retained.execution = execution
      await this.budgets.finish(execution.id, execution.finishedAt)
      await store.settleNativeExecution(execution.id)
      check()
      retained.context = { ...retained.context, purpose: 'reviewer' }
      this.reviewerSessions.maintainRetainedReviewer(retained)
      return
    }
    try { await store.settleNativeExecution(execution.id); check(); return }
    catch (error) { if (!repeatPhysicalSettlementPending(error)) throw error; check() }
    const owned = this.ownedSessions.get(execution.id)
    if (owned) {
      // Workflow terminal repair must never close a later reviewer lifetime on
      // the same execution. Only its captured review job may do that.
      if (owned.context.purpose === 'reviewer') throw new DomainError('REPEAT_CLEANUP_PENDING',
        'The exact reviewer lifetime is still responsible for its cleanup.', 409)
      assertSameRepeatExecution(owned.execution, execution)
      if (!owned.session || owned.session.nativeSessionId !== execution.nativeSessionId) throw new DomainError(
        'REPEAT_CLEANUP_PENDING', 'No captured session matches the terminal execution.', 409)
      owned.execution = execution
      await this.budgets.finish(execution.id, execution.finishedAt)
      check()
      await this.lifecycle.closeRepeatLifetime(owned, check,
        () => finishRecoveredWorkflowCredentials(owner, execution, this.credentials, signal))
    } else {
      // A crash after close/COMMIT is repaired without touching a native manager.
      // The proof reader rejects newer generations and any older unclosed one.
      const proof = await this.workflowClosures?.read(execution)
      check()
      if (!proof) throw new DomainError('REPEAT_CLEANUP_PENDING',
        'No durable exact-session closure exists. Native work will not be restarted.', 409)
      await this.budgets.finish(execution.id, execution.finishedAt)
      check()
      // Capture and revoke only exact workflow-purpose principals under the
      // owner/closure fence. Never revoke a successor reviewer's credential.
      await finishRecoveredWorkflowCredentials(owner, execution, this.credentials, signal)
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
    const safe = nativePersistenceRedactor(this.credentialLedger.secrets(owned.manager))
    if (!manager.settleTurn) throw new DomainError('NATIVE_SETTLEMENT_UNAVAILABLE', 'The original native settlement port is unavailable.', 409)
    await this.interactions.coordination.acknowledgeLaneTurn(lane.fence, terminal.correlationId, terminal.providerId)
    lane.providerId = terminal.providerId
    const settled = await manager.settleTurn(session, terminal.correlationId, lane.guard.signal)
    assertOriginalWorkflowTerminal(owned.execution, session, settled, terminal.correlationId)
    if (!isDeepStrictEqual(settled.terminalTurn, terminal)) throw new DomainError(
      'NATIVE_TERMINAL_SOURCE_REQUIRED', 'The settled result differs from the validated provider output.', 409)
    const evidence = this.captureNative(owner, owned.execution,
      { type: 'history', history: safe.value(settled) }, 'recovery', lane)
    if (owned.execution.resultProtocol) await this.runs.publishWorkflowTerminalSettlement(owned.execution, owner, evidence)
    else await this.runs.retainSettledTerminal(owner, evidence)
    owned.outputSettlementComplete = true
  }

  async recoverOutputSettlement(execution: HarnessExecution, owner: RunOwnership,
    signal?: AbortSignal): Promise<boolean> {
    let owned = this.ownedSessions.get(execution.id)
    if (owned?.outputSettlementComplete || owned?.context.purpose === 'reviewer') return false
    if (owned && !this.rawManagers.get(owned.manager)?.settleTurn) return false
    const proof = await this.runs.readOutputSettlement(execution, owner)
    if (!proof || proof.original.type !== 'history' || !proof.original.history.terminalTurn) return false
    const terminal = proof.original.history.terminalTurn
    if (!owned) {
      const lifetime = await readRemoteOutputSettlement(owner, execution, proof)
      if (!lifetime) return false
      await this.waitForRestartWriter(owner, execution, lifetime.session, terminal.correlationId,
        () => readRemoteOutputSettlement(owner, execution, proof), signal)
      const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
      const run = await this.runs.get(execution.runId, owner)
      if (!configuration || !run) throw new DomainError('NATIVE_SETTLEMENT_UNAVAILABLE', 'The saved execution configuration is unavailable.', 409)
      await this.validateContinuation?.(execution.id, signal)
      const request = await this.workflowRequest(execution, configuration, run, owner)
      const context = { ...await this.managerContext(execution, configuration), workflowRequest: request }
      const resolved = this.resolveManager(context, owner)
      if (resolved.processState === 'needs_start') resolved.beginStart?.()
      owned = this.lifecycle.ownSession(execution, context, resolved.manager)
      owned.runOwner = owner
      owned.session = lifetime.session
      owned.closureGeneration = lifetime.generation
      owned.closureRegistration = Promise.resolve(lifetime.generation)
      owned.terminalRecoveredWithoutCredential = true
      const attached = await this.lifecycle.openingSession(owned, resolved.manager.attachSession(lifetime.session,
        { kind: 'workflow', correlationId: terminal.correlationId, request }, signal))
      this.assertSessionIdentity(lifetime.session, attached)
      resolved.markResident?.()
    }
    owned.execution = execution
    const retained = owned
    await retained.manager.withLane(retained.session!, terminal.correlationId, signal,
      (manager, lane) => this.finishOutputSettlement(retained, owner, terminal, manager, lane))
    return true
  }

  // ---- ExecutionReviewerSessions: delegates to the extracted collaborator
  /** Snapshot the owned process values before a terminal cleanup can discard them. */
  reviewPersistence(executionId: string) {
    return this.reviewerSessions.reviewPersistence(executionId)
  }

  captureReviewNative(executionId: string, session: NativeSessionReference, job: ReviewJob,
    lane: SessionWriteLease, source: ReviewOriginalNativeSource): ReviewNativeCapture {
    return this.reviewerSessions.captureReviewNative(executionId, session, job, lane, source)
  }

  reviewCredentialIdentity(executionId: string, session: NativeSessionReference): { required: boolean; principalId?: string } {
    return this.reviewerSessions.reviewCredentialIdentity(executionId, session)
  }

  async revokeReviewCredential(principalId: string): Promise<void> {
    return this.reviewerSessions.revokeReviewCredential(principalId)
  }

  async recoverReviewCleanup(executionId: string, session: NativeSessionReference, job: ReviewJob,
    signal: AbortSignal): Promise<ReviewCleanupSession> {
    return this.reviewerSessions.recoverReviewCleanup(executionId, session, job, signal)
  }

  async maintainReviewCredential(executionId: string, session: NativeSessionReference, parentSignal: AbortSignal,
    assertOwned: () => Promise<void>): Promise<ReviewCredentialMaintenance> {
    return this.reviewerSessions.maintainReviewCredential(executionId, session, parentSignal, assertOwned)
  }

  async recordReviewFailure(executionId: string, job: ReviewJob, error: NonNullable<ReviewJob['error']>,
    pending?: PendingNativeInteraction, pendingRequests?: readonly PendingNativeInteraction[]): Promise<void> {
    return this.reviewerSessions.recordReviewFailure(executionId, job, error, pending, pendingRequests)
  }

  async prepareReviewTurn(executionId: string, session: NativeSessionReference, job: ReviewJob,
    lane: SessionWriteLease, signal: AbortSignal): Promise<void> {
    return this.reviewerSessions.prepareReviewTurn(executionId, session, job, lane, signal)
  }

  async releaseReviewSession(executionId: string): Promise<void> {
    return this.reviewerSessions.releaseReviewSession(executionId)
  }

  afterReviewCommit(executionId: string): Promise<void> {
    return this.reviewerSessions.afterReviewCommit(executionId)
  }

  /** Capture at reviewer attachment, not in its eventual finally callback. The
   * marker also distinguishes two jobs reusing the same resident connection. */
  captureReviewFinalizer(executionId: string, session: NativeSessionReference, assigned: ReviewJob):
    ((settled: ReviewJob) => Promise<void>) | undefined {
    return this.reviewerSessions.captureReviewFinalizer(executionId, session, assigned)
  }

  async finishIdleReviewers(runId: string, owner: RunOwnership, signal: AbortSignal): Promise<void> {
    return this.reviewerSessions.finishIdleReviewers(runId, owner, signal)
  }

  readonly runs: PostgresRunRepository
  readonly interactions: PostgresInteractionRepository
  readonly budgets: PostgresApprovalBudgetRepository
  readonly managers: NativeSessionManagerResolver
  readonly activeTimeoutMs: number
  readonly credentials: ExecutionCredentialProvider | undefined
  readonly validateContinuation: ApprovalExecutionDependencies['validateContinuation']
  readonly workflowClosures: WorkflowClosureStore | undefined
  private readonly repeatReviewerBindings: RepeatReviewerBindings | undefined
  private readonly nativeCaptures: WorkflowNativeCapturePort | undefined
  readonly reviewNativeCaptures: ReviewNativeCapturePort | undefined
  readonly recoverNativeProcesses: ApprovalExecutionDependencies['recoverNativeProcesses']
  readonly reserveNativeLaunch: ApprovalExecutionDependencies['reserveNativeLaunch']
  private readonly prepareManagerContext: ApprovalExecutionDependencies['prepareManagerContext']
  readonly commitReviewNative: ApprovalExecutionDependencies['commitReviewNative']
  readonly collaboration: WorkflowCollaborationIntegration | undefined

  constructor(dependencies: ApprovalExecutionDependencies) {
    this.runs = dependencies.runs
    this.interactions = dependencies.interactions
    this.budgets = dependencies.budgets
    this.managers = dependencies.managers
    this.activeTimeoutMs = dependencies.activeTimeoutMs
    this.credentials = dependencies.credentials
    this.credentialLedger = new NativeCredentialLedger(dependencies.credentials)
    this.validateContinuation = dependencies.validateContinuation
    this.workflowClosures = dependencies.workflowClosures
    this.repeatReviewerBindings = dependencies.repeatReviewerBindings
    this.nativeCaptures = dependencies.nativeCaptures
    this.reviewNativeCaptures = dependencies.reviewNativeCaptures
    this.recoverNativeProcesses = dependencies.recoverNativeProcesses
    this.reserveNativeLaunch = dependencies.reserveNativeLaunch
    this.prepareManagerContext = dependencies.prepareManagerContext
    this.commitReviewNative = dependencies.commitReviewNative
    this.collaboration = dependencies.collaboration
    this.reviewers = new ReviewerDispatcher(this.interactions.coordination, this)
    this.lifecycle = new ExecutionSessionLifecycle(this)
    this.consultations = new ExecutionConsultations(this)
    this.reviewerSessions = new ExecutionReviewerSessions(this)
    this.cancellation = new ExecutionCancellation(this)
  }

  /** Production builds this coordinator from CurrentApprovalExecutionDependencies, so every native port is present. */
  assertCurrentProduction(runs: PostgresRunRepository): void {
    if (this.runs !== runs) throw new DomainError(
      'CURRENT_NATIVE_COMPOSITION_REQUIRED', 'The coordinator must use the current production Run repository.', 503)
    this.interactions.coordination.assertOriginalNativeComposition()
  }

  private captureNative(owner: RunOwnership, execution: HarnessExecution, source: WorkflowOriginalNativeSource,
    kind: 'live' | 'recovery', lease?: SessionWriteLease): RepeatNativeEvidence {
    const owned = this.ownedSessions.get(execution.id)
    if (!owned?.session || owned.consultation || !this.nativeCaptures) throw new DomainError('NATIVE_CAPTURE_COMPOSITION_REQUIRED',
      'The original native coordinator capture channel is not composed.', 409)
    const manager = owned.manager, session = owned.session, generation = owned.generation
    const closureGeneration = owned.closureGeneration ?? null
    return this.nativeCaptures.capture({ owner, execution, session, manager, source, kind, ...(lease ? { lease } : {}),
      lifetimeGeneration: generation, closureGeneration,
      assertCurrent: () => {
        owner.assertOwned()
        if (this.ownedSessions.get(execution.id) !== owned || owned.manager !== manager || owned.session !== session
          || owned.generation !== generation || (owned.closureGeneration ?? null) !== closureGeneration
          || owned.opening || owned.openingFailed || owned.failed || owned.controller.signal.aborted) {
          throw new DomainError('NATIVE_LIFETIME_CHANGED', 'The original native source lost its coordinator lifetime.', 409)
        }
      } })
  }

  /** Permission to observe/attach only the exact accepted session. This capture
   * is not a terminal result, no-submission proof or native acknowledgement. */
  async nativeBoundaryEvidence(executionId: string, owner: RunOwnership): Promise<RepeatNativeEvidence> {
    const execution = await this.runs.getExecution(executionId, owner)
    if (!execution) throw new DomainError('EXECUTION_NOT_FOUND', 'The exact execution is unavailable.', 404)
    await this.reviewerSessions.recoverRetainedReviewer(execution, owner)
    const owned = this.ownedSessions.get(executionId)
    if (owned?.session) {
      owned.runOwner = owner
      this.managers.adoptOwner?.(executionId, this.rawManagers.get(owned.manager) ?? owned.manager, owner)
      await owned.manager.observeBoundary(owned.session, owned.controller.signal)
    }
    return this.captureNative(owner, execution, { type: 'boundary' }, 'recovery')
  }

  /** Bind only an existing execution of the designated reviewer in this Run. Never spawn a substitute. */
  async enqueueReview(interaction: DurableInteraction): Promise<void> {
    if (interaction.status !== 'pending' || interaction.approval.handler !== 'orchestrator') return
    const agentId = interaction.approval.designatedOrchestratorAgentId
    if (!agentId || agentId === interaction.requestingAgentId) return
    const connection = await this.interactions.assertOrchestratorConnection(interaction)
    const existingJob = await this.interactions.coordination.findReviewJob(interaction.id, agentId)
    if (existingJob) {
      await this.interactions.coordination.assertReviewConnection(existingJob)
      return
    }
    if (!this.repeatReviewerBindings || !connection) throw new DomainError('REPEAT_REVIEW_IDENTITY_CONFLICT',
      'The occurrence-qualified reviewer binding is unavailable.', 409)
    const executions = [(await this.repeatReviewerBindings.select(interaction, connection.orchestratorNodeId)).execution]
    const candidates = executions
      .filter((execution) => execution.agentId === agentId && execution.workflowNodeId === connection?.orchestratorNodeId
        && execution.nativeSessionId && execution.workingDirectory && execution.runtimeDirectory)
    // No guessing between attempts/sessions. The pending interaction remains the recovery source.
    if (candidates.length !== 1) return
    const execution = candidates[0]!
    const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    if (!configuration || (configuration.productRole !== 'master' && configuration.productRole !== 'orchestrator')) return
    const native = await this.interactions.coordination.workflowSession(execution.id)
    if (!native?.finalized || execution.state !== 'completed') return
    await this.reviewers.enqueue(interaction, agentId, {
      ...native.session,
    }, { executionId: execution.id, workingDirectory: execution.workingDirectory! })
  }

  /** Pending interactions repair a crash between creation and enqueue, including sessions bound later. */
  async reconcileReviews(onError: (error: unknown) => void): Promise<void> {
    let afterId: string | undefined
    do {
      const page = await this.interactions.list({ handler: 'orchestrator', status: 'pending', limit: 100,
        ...(afterId ? { afterId } : {}) })
      for (const interaction of page) await this.enqueueReview(interaction).catch(onError)
      afterId = page.length === 100 ? page.at(-1)!.id : undefined
    } while (afterId)
    await this.reviewers.reconcile(onError)
  }

  detachedWorkflowSession(owner: RunOwnership,
    execution: HarnessExecution): Promise<NativeSessionReference | undefined> {
    if (this.workflowClosures?.recoverDetached) return this.workflowClosures.recoverDetached(owner, execution)
    return readDetachedWorkflowSession(owner, execution)
  }

  private async waitForRestartWriter(owner: RunOwnership, execution: HarnessExecution,
    session: NativeSessionReference, correlationId: string, readLifetime: () => Promise<unknown>, signal?: AbortSignal) {
    owner.assertOwned()
    signal?.throwIfAborted()
    const lane = await this.interactions.coordination.getLane(session.harness, session.nativeSessionId)
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
      if (this.closing) throw new DomainError('ENGINE_RESTART',
        'The native session recovery is stopping for application restart.', 409)
      const currentLifetime = await readLifetime()
      const currentLane = await this.interactions.coordination.getLane(session.harness, session.nativeSessionId)
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
    const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
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
      this.managers.release?.(context, this.rawManagers.get(resolved.manager) ?? resolved.manager, 'failed')
      await this.cancellation.restartInterrupted(owner, execution)
      throw new HarnessExecutionError('EXECUTION_INTERRUPTED',
        'The original workflow native process is no longer available.', true)
    }
    try {
      await this.attachSession(context, session, { restartOwner: owner })
    } catch (error) {
      if (error instanceof HarnessExecutionError && error.result.error?.code === 'EXECUTION_INTERRUPTED') {
        await this.cancellation.restartInterrupted(owner, execution)
      }
      throw error
    }
    owner.assertOwned()
  }

  /** Revalidate source under the resident session's writer lease between turns. */
  async withSourceObservationLane<T>(owner: RunOwnership, execution: HarnessExecution, work: () => Promise<T>): Promise<T> {
    owner.assertOwned()
    if (owner.runId !== execution.runId) throw new DomainError('RUN_OWNERSHIP_LOST', 'Source observation requires its original Run owner.', 409)
    if (!this.ownedSessions.has(execution.id)) await this.restoreSourceSession(owner, execution)
    const owned = this.ownedSessions.get(execution.id)
    if (!owned?.session) return work()
    const session = owned.session, generation = owned.generation
    const check = () => {
      owner.assertOwned()
      if (this.ownedSessions.get(execution.id) !== owned || owned.session !== session || owned.generation !== generation
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
    return [...this.ownedSessions.values()].flatMap(owned => {
      if (!owned.session || owned.consultation || owned.failed || owned.cleanup) return []
      const lease = owned.manager.capturedLease(owned.session)
      const manager = this.rawManagers.get(owned.manager)
      if (!lease || !manager || lease.guard.signal.aborted) return []
      const session = owned.session, generation = owned.generation
      return [{ execution: structuredClone(owned.execution), session: structuredClone(session), manager,
        generation, signal: lease.guard.signal, writer: { id: lease.fence.id, token: lease.fence.token, connectionGeneration: lease.previous.connectionGeneration },
        assertCurrent: () => {
          if (this.ownedSessions.get(owned.execution.id) !== owned || owned.generation !== generation || owned.session !== session
            || owned.failed || owned.cleanup || owned.controller.signal.aborted) throw new DomainError('WORKER_EXECUTION_IDENTITY_INVALID', 'The captured native manager lifetime is no longer current.', 409)
          owned.manager.assertCapturedLease(session, lease)
        } }]
    })
  }

  /** Public controls reuse this coordinator's current Run/native ownership.
   * Readback only projects the original observer's durable source. */
  workflowChatOwner(sql: SqlQuery,
    validateAdmission: WorkflowChatOwnerPort['validateAdmission']) {
    return this.workflowControls = createWorkflowChatOwner({ sql, runs: this.runs, validateAdmission,
      withOwner: async (target, work) => {
        const id = target.kind === 'workflow_execution' ? target.execution.executionId
          : (await sql.query<{ parent_execution_id: string }>(`select parent_execution_id from run_hierarchy_groups
            where run_id=$1 and parent_activation_id=$2 and parent_node_id=$3`,
          [target.runId, target.waitingActivationId, target.agent.workflowNodeId])).rows[0]?.parent_execution_id
        const source = id && await this.runs.getExecution(id)
        if (!source) throw new DomainError('CHAT_TARGET_NOT_FOUND', 'The exact Run-owned chat source is unavailable.', 404)
        const retained = await this.retainRunOwner(source, () => {})
        try { return await work(retained.owner, source) }
        finally { await retained.release() }
      },
      capture: (target, source) => this.captureWorkflowChatNative(target, this.ownedSessions.get(source.id)),
      captureForRead: target => this.captureWorkflowChatNative(target, target.kind === 'workflow_execution'
        ? this.ownedSessions.get(target.execution.executionId)
        : [...this.ownedSessions.values()].find(owned => owned.consultation?.binding.runId === target.runId
          && owned.consultation.binding.waitingActivationId === target.waitingActivationId)),
      dispatchConsultation: (target, command, owner, source) => this.consultations.dispatchWorkflowConsultation(target, command, owner, source),
    })
  }

  private captureWorkflowChatNative(target: WorkflowChatTarget,
    owned: OwnedNativeSession | undefined): WorkflowChatNativeCapture | undefined {
    if (!owned?.session || owned.failed || owned.cleanup || owned.opening || owned.controller.signal.aborted
      || !owned.activeSessionMode || this.closing || this.stoppingRuns.has(owned.execution.runId)) return undefined
    if (target.kind === 'workflow_execution' ? owned.execution.id !== target.execution.executionId || !!owned.consultation
      || owned.context.purpose === 'reviewer' : !owned.consultation
      || owned.consultation.binding.runId !== target.runId
      || owned.consultation.binding.waitingActivationId !== target.waitingActivationId) return undefined
    const session = owned.session, generation = owned.generation, mode = owned.activeSessionMode
    const lease = owned.manager.capturedLease(session), raw = this.rawManagers.get(owned.manager)
    if (!lease?.providerId || !raw || lease.guard.signal.aborted || lease.observedStatus === 'idle') return undefined
    const providerId = lease.providerId
    return { session, manager: owned.manager, lease,
      native: { nativeSessionId: session.nativeSessionId, ownerRequestId: lease.correlationId, providerId,
        ...(session.harness === 'codex' ? { nativeTurnId: providerId } : { inputMessageId: providerId }),
        sessionMode: mode, steer: supportsExpectedTurnSteer(session) && !!raw.steerTurn, interruptAndSend: true },
      assertCurrent: () => {
        if (this.ownedSessions.get(owned.execution.id) !== owned || owned.session !== session
          || owned.generation !== generation || owned.activeSessionMode !== mode || lease.providerId !== providerId
          || owned.failed || owned.cleanup || owned.controller.signal.aborted) throw new DomainError(
          'CHAT_NATIVE_TARGET_CHANGED', 'The captured original native owner changed.', 409)
        owned.manager.assertCapturedLease(session, lease)
      } }
  }

  /** The engine's existing reconciliation pass repairs admission/dispatch gaps.
   * Dispatch itself reconciles unknown offers and never submits them twice. */
  async reconcileWorkflowControls(onError: (error: unknown) => void): Promise<void> {
    const owners = new Map(this.sharedRunOwners)
    for (const owned of this.ownedSessions.values()) {
      if (owned.runOwner && !owners.has(owned.execution.runId)) owners.set(owned.execution.runId, owned.runOwner)
    }
    for (const owner of owners.values()) {
      await this.recoverExecutionControls(owner).catch(error => {
        // A cached owner that already lost its lock has nothing to recover; its Run is resumed under a new owner.
        if (!(error instanceof DomainError && error.code === 'RUN_OWNERSHIP_LOST')) onError(error)
      })
    }
  }

  async recoverExecutionControls(owner: RunOwnership): Promise<void> {
    if (!this.workflowControls) return
    let after = '0'
    for (;;) {
      owner.assertOwned()
      const rows = (await owner.oneShotConnection().query<{ id: string; target: WorkflowChatTarget; sequence: string }>(
        `select id,target,sequence::text from run_chat_commands where run_id=$1 and sequence>$2::bigint
          and target->>'kind'='workflow_execution' and operation in ('stop','interrupt','steer')
          and state in ('recorded','settling','submitting','unknown','accepted')
          order by run_chat_commands.sequence limit 100`, [owner.runId, after])).rows
      for (const row of rows) {
        owner.assertOwned()
        await this.workflowControls.dispatch(row.target, row.id)
      }
      if (rows.length < 100) return
      after = rows.at(-1)!.sequence
    }
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
    if (configuration.harness.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    }
    const context = {
      harness: configuration.harness.harness, executionId: execution.id, agentId: execution.agentId,
      runId: execution.runId, attempt: execution.attempt,
      ...(execution.nativeSessionId ? { nativeSessionId: execution.nativeSessionId } : {}),
      workingDirectory: execution.workingDirectory, configuration,
      ...(purpose ? { purpose } : {}),
    }
    return this.prepareManagerContext ? this.prepareManagerContext(context) : context
  }

  resolveManager(context: NativeManagerResolutionContext, owner?: RunOwnership) {
    const resolved = this.managers.resolve(context, owner)
    if (resolved.manager.harness !== context.harness) {
      throw new Error('The resolved native manager does not match the durable execution harness.')
    }
    let manager = this.writers.get(resolved.manager)
    if (!manager) {
      manager = coordinateSessionManager(resolved.manager, this.interactions.coordination, context.agentId)
      this.writers.set(resolved.manager, manager)
      this.rawManagers.set(manager, resolved.manager)
    }
    return {
      ...resolved, manager,
      get processState() { return resolved.processState },
    }
  }

  async workflowRequest(execution: HarnessExecution, configuration: AgentConfigurationVersion,
    run: Pick<WorkflowRun, 'id' | 'workflowVersionId' | 'workspaceId' | 'resultProtocol'>, owner?: RunOwnership) {
    const version = await this.runs.getRepeatVersion(run.id, run.workflowVersionId, owner)
    let executionContext
    if (version.definition.handoffs && repeatTickIndex(execution.input) === undefined) {
      const retained = owner ? undefined : await this.retainRunOwner(execution, () => {})
      try {
        executionContext = await (await this.runs.repeat(owner ?? retained!.owner)).readWorkExecutionContext(execution.id)
      } finally { await retained?.release() }
    }
    const retained = !owner ? await this.retainRunOwner(execution, () => {}) : undefined
    let collaborationPrompt: string | undefined
    let queuedInput: WorkflowQueuedInput | undefined
    try {
      const currentOwner = owner ?? retained!.owner
      collaborationPrompt = await this.collaboration?.readPrompt(currentOwner, execution, version)
      queuedInput = await (await this.runs.repeat(currentOwner)).claimWorkflowInput(execution.id)
    }
    finally { await retained?.release() }
    const team = await readWorkflowTeam(version, execution.workflowNodeId, id => this.runs.getExecutionConfiguration(id))
    return appendWorkflowChatInput(workflowExecutionRequest({ execution, version, configuration, workspaceId: run.workspaceId, executionContext, collaborationPrompt, team,
      ...(run.resultProtocol ? { resultProtocol: run.resultProtocol } : {}) }), queuedInput)
  }

  private prepareEnvironment(
    context: NativeManagerResolutionContext,
    resolved: ResolvedNativeSessionManager,
    options: { signal?: AbortSignal | undefined; purpose?: 'reviewer' | undefined;
      enterNative?: () => Promise<void>; restartOwner?: RunOwnership | undefined },
  ): Promise<IssuedWorkerCredential['environment'] | undefined> {
    const owned = this.ownedSessions.get(context.executionId)!
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
    const owned = this.ownedSessions.get(context.executionId)
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
    if (this.workflowClosures) {
      // The original process intent must be durable before entered commits.
      // Allocation/reviewer cleanup alone must not reserve or dispatch anything.
      if (resolved.processState === 'needs_start' && !owned.launchReserved && !continuing) {
        signal?.throwIfAborted()
        owned.launchReservation ??= Promise.resolve().then(async () => {
          await this.reserveNativeLaunch?.(context.executionId, this.rawManagers.get(owned.manager) ?? owned.manager)
          owned.launchReserved = true
        })
        await owned.launchReservation
      }
      owned.closureRegistration ??= this.workflowClosures.begin(owned.execution)
      const generation = await owned.closureRegistration
      if (owned.closureGeneration !== generation) {
        this.closedExecutions.delete(context.executionId)
        this.closedWorkflowSessions.delete(context.executionId)
        owned.closureGeneration = generation
      }
      if (owned.restartRecovery) owned.restartRecovery.attachmentGeneration = generation
      signal?.throwIfAborted()
      if (this.ownedSessions.get(context.executionId) !== owned || owned.controller.signal.aborted) {
        throw new Error('Native preflight lost its manager owner.')
      }
    }
    await enterNative?.()
    signal?.throwIfAborted()
    if (!this.credentials) return undefined
    if (owned.session && owned.restartAttachment && context.acceptedPlacement?.hostRef.kind === 'device'
      && resolved.processState === 'needs_start') {
      if (!this.credentials.restore) throw new DomainError('NATIVE_CREDENTIAL_RECOVERY_REQUIRED',
        'The original Worker credential cannot be restored.', 409)
      const { session, request } = owned.restartAttachment
      const lane = await this.interactions.coordination.getLane(session.harness, session.nativeSessionId)
      const identity = reviewPreflightIdentity(lane, `execution:${context.executionId}`)
      const attached = await this.lifecycle.openingSession(owned,
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
      const credential = await this.credentials.restore(context.executionId, { agentId: context.agentId,
        variables: { [APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]: access.token } })
      if (continuing) {
        const current = await readRemoteWorkflowContinuation(restartOwner!, owned.execution)
        const expected = { ...continuing, generation: owned.closureGeneration, detached: false }
        if (credential.principalId !== continuing.principalId || !isDeepStrictEqual(current, expected)) {
          throw new DomainError('NATIVE_CREDENTIAL_RECOVERY_REQUIRED', 'The original remote process lease changed.', 409)
        }
      }
      if (owned.closureGeneration) credential.nativeLifetimeGeneration = owned.closureGeneration
      this.credentialLedger.set(resolved.manager, credential)
      signal?.throwIfAborted()
      resolved.markResident?.()
      return undefined
    }
    if (owned.session && resolved.manager.originalEnvironment && resolved.processState === 'needs_start') {
      const variables = await resolved.manager.originalEnvironment(owned.session, signal)
      if (variables) {
        if (!this.credentials.restore) throw new DomainError('NATIVE_CREDENTIAL_RECOVERY_REQUIRED',
          'The original native process credential cannot be restored.', 409)
        const credential = await this.credentials.restore(context.executionId, { agentId: context.agentId, variables })
        if (owned.closureGeneration) credential.nativeLifetimeGeneration = owned.closureGeneration
        this.credentialLedger.set(resolved.manager, credential)
        signal?.throwIfAborted()
        return credential.environment
      }
    }
    if (resolved.processState === 'resident') {
      const credential = this.credentialLedger.get(resolved.manager)
      if (!credential) throw new Error('The resident native process has no owned worker credential lease.')
      const remaining = remainingCredentialLifetime(credential)
      if (!Number.isFinite(remaining)) throw new Error('The worker credential expiry is invalid.')
      if (remaining <= 0) {
        throw new Error('The resident worker credential cannot be renewed without replacing its process.')
      }
      if (this.credentials.renew && remaining <= WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) {
        await this.credentialLedger.renew(resolved.manager, context.executionId, {
          signal,
          check: async () => { signal?.throwIfAborted() },
        })
      }
      signal?.throwIfAborted()
      // A resident process keeps its original token/environment, including across long waits.
      return undefined
    }
    const prepared = await this.credentials.prepare({
      executionId: context.executionId, harness: context.harness, workingDirectory: context.workingDirectory,
      ...(purpose ? { purpose } : {}),
      ...(signal ? { signal } : {}),
    })
    const remaining = remainingCredentialLifetime(prepared.credential)
    if (!Number.isFinite(remaining) || remaining <= 0) throw new Error('The prepared worker credential is not live.')
    if (owned.closureGeneration) prepared.credential.nativeLifetimeGeneration = owned.closureGeneration
    this.credentialLedger.set(resolved.manager, prepared.credential)
    signal?.throwIfAborted()
    return prepared.credential.environment
  }

  private maintainWaitingWorkflowCredential(owned: OwnedNativeSession): void {
    const initial = this.credentialLedger.get(owned.manager)
    const session = owned.session
    if (owned.stopWaitingRenewal || !initial || !session || !this.credentials?.renew) return
    const generation = owned.generation
    const lifetime = owned.closureGeneration
    const check = async () => {
      owned.controller.signal.throwIfAborted()
      const credential = this.credentialLedger.get(owned.manager)
      if (this.ownedSessions.get(owned.execution.id) !== owned || !isDeepStrictEqual(owned.session, session)
        || owned.generation !== generation || owned.closureGeneration !== lifetime || owned.failed || owned.cleanup
        || credential?.principalId !== initial.principalId || credential.environment !== initial.environment) {
        throw new DomainError('WORKER_CREDENTIAL_LOST', 'The waiting requester no longer owns its native lifetime.', 409)
      }
      const current = await this.runs.getExecution(owned.execution.id)
      if (!current || current.state !== 'waiting') throw new DomainError(
        'WORKER_EXECUTION_TERMINAL', 'The requester no longer has a pending approval wait.', 409)
      assertSameRepeatExecution(owned.execution, current)
      if (current.nativeSessionId !== session.nativeSessionId) throw new DomainError(
        'NATIVE_SESSION_IDENTITY_MISMATCH', 'The waiting requester session changed.', 409)
      await this.validateContinuation?.(owned.execution.id, owned.controller.signal)
      owned.controller.signal.throwIfAborted()
    }
    owned.stopWaitingRenewal = renewOwnedLeases({
      signal: owned.controller.signal,
      check,
      leases: [this.credentialLedger.lease(owned.manager, async () => {
        try {
          await owned.manager.withCredentialLease(session, owned.controller.signal, async signal => {
            await this.credentialLedger.renew(owned.manager, owned.execution.id, { signal, check: async () => {
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

  // ---- ExecutionCancellation: delegates to the extracted collaborator
  async preserveActiveForRestart(owner: RunOwnership): Promise<boolean> {
    return this.cancellation.preserveActiveForRestart(owner)
  }

  /** Production calls this AFTER stopping/draining producers and BEFORE raw
   * manager disposal. Waiting Workers and retained reviewers are not Stop: their
   * checkpoints, budgets, credentials and business records must survive restart.
   * Every sibling is attempted; failed/uncertain closure keeps shutdown failed. */
  closeForRestart(): Promise<void> {
    return this.cancellation.closeForRestart()
  }

  /** Recover restart-detached turns and checkpoint-bound approvals, answered or not.
   * Other cold nonterminal lifetimes require physical cleanup before settlement. */
  async requestColdRunCleanup(owner: RunOwnership, approvals: readonly DurableInteraction[] = [],
    signal?: AbortSignal): Promise<boolean> {
    return this.cancellation.requestColdRunCleanup(owner, approvals, signal)
  }

  /** Close one failed check before its successor can be admitted. */
  async failIntervalCheck(owner: RunOwnership, execution: HarnessExecution,
    failure: ExecutionResult = { outcome: 'failed', error: {
      code: 'EXECUTION_INTERRUPTED',
      message: 'The native attempt was closed without an accepted result.',
      retryable: false,
    } }): Promise<void> {
    return this.cancellation.failIntervalCheck(owner, execution, failure)
  }

  /** Close one attempt for its own recorded cause, without fencing the Run or
   * touching sibling credentials, budgets or sessions. Closure is best effort:
   * an unconfirmed close leaves only this attempt's settlement pending. A
   * retryable cause lets the node start a fresh attempt with the same input. */
  async abandonAttempt(owner: RunOwnership, execution: HarnessExecution, failure: ExecutionResult): Promise<void> {
    return this.cancellation.abandonAttempt(owner, execution, failure)
  }

  /** Stop first fences all new work in the database. This pass only cancels
   * ORIGINAL resident managers and revokes execution resources under that fence.
   * The owner-only cold pass also recovers failed resident transports using
   * positive closure receipts for their captured lifetime generation.
   * Positive repository proof, not this method's return value, settles a Run. */
  async cancelRun(runId: string, owner?: RunOwnership): Promise<void> {
    return this.cancellation.cancelRun(runId, owner)
  }

  async finishRun(runId: string): Promise<void> {
    const run = await this.runs.get(runId)
    if (run?.executionState !== 'completed') throw new DomainError('GRAPH_TERMINAL_CONFLICT', 'Only a terminal Run may finish native cleanup.', 409)
    const failures: Error[] = []
    for (const owned of this.ownedSessions.values()) {
      if (owned.execution.runId !== runId) continue
      // An active reviewer may be awaiting this graph response through MCP.
      // Its captured job finalizer releases the exact session after settlement.
      if (owned.session && owned.manager.isActive(owned.session)) continue
      if (owned.context.purpose === 'reviewer' && owned.manager.retainsReviewerSession
        && owned.context.acceptedPlacement?.hostRef.kind === 'device') {
        const owner = owned.runOwner
        if (!owner) throw new DomainError('RUN_OWNERSHIP_LOST', 'The reviewer Run owner is unavailable.', 409)
        await this.finishIdleReviewers(runId, owner, owned.controller.signal)
        continue
      }
      failures.push(...await this.lifecycle.cleanupSession(owned, false))
    }
    if (failures.length) throw new AggregateError(failures, 'Completed Run session cleanup was incomplete.')
    this.capacity.release(runId)
  }

  /** Read-only exact callback qualification. A cold read never allocates or attaches a manager. */
  async inspectInteractionActivity(interaction: DurableInteraction): Promise<InteractionActivityEvidence> {
    const identity = { interactionId: interaction.id, revision: interaction.revision, sessionId: interaction.nativeSessionId,
      requestId: interaction.nativeRequestId, executionId: interaction.executionId }
    const unavailable: InteractionActivityEvidence = { response: { authorized: false, qualified: false,
      path: null, usable: false, identity } }
    const owned = this.ownedSessions.get(interaction.executionId)
    if (!owned?.session || this.closing || owned.failed || owned.cleanup || owned.openingFailed
      || owned.controller.signal.aborted || this.stoppingRuns.has(interaction.runId)) return unavailable
    const execution = await this.runs.getExecution(interaction.executionId)
    const run = await this.runs.get(interaction.runId)
    if (!execution || !run || execution.runId !== interaction.runId || execution.agentId !== interaction.requestingAgentId
      || execution.nativeSessionId !== interaction.nativeSessionId || execution.state === 'completed'
      || run.workspaceId !== interaction.workspaceId || run.workflowId !== interaction.workflowId || run.outcome !== 'pending'
      || owned.execution.id !== execution.id || owned.execution.attempt !== execution.attempt
      || owned.session.nativeSessionId !== interaction.nativeSessionId || owned.session.harness !== interaction.harness
      || owned.session.providerVersion !== interaction.providerVersion) return unavailable
    const manager = this.rawManagers.get(owned.manager) ?? owned.manager
    const response = await inspectNativeResponse(manager, owned.session, {
      nativeRequestId: interaction.nativeRequestId, nativeRequestType: interaction.nativeRequestType,
    }, { signal: AbortSignal.any([owned.controller.signal, AbortSignal.timeout(5_000)]),
      isCurrent: () => this.ownedSessions.get(execution.id) === owned && !this.closing && !owned.cleanup
        && !owned.failed && !owned.controller.signal.aborted && !this.stoppingRuns.has(interaction.runId) })
    return { response: { authorized: false, qualified: response.qualified, usable: response.state === 'available',
      path: response.state === 'available' ? response.path : null, identity },
      ...(response.nativeTurnId ? { nativeTurnId: response.nativeTurnId } : {}) }
  }

  async validateInteraction(interaction: DurableInteraction, signal?: AbortSignal): Promise<void> {
    await this.validateContinuation?.(interaction.executionId, signal)
  }

  hasOriginalRequester(interaction: DurableInteraction): boolean {
    const owned = this.ownedSessions.get(interaction.executionId)
    return !!owned?.session && !owned.failed && !owned.cleanup && !owned.opening
      && !owned.openingFailed && !owned.pendingApprovalRestoration && owned.generation > 0
      && !owned.controller.signal.aborted && owned.execution.runId === interaction.runId
      && owned.session.nativeSessionId === interaction.nativeSessionId
      && owned.session.harness === interaction.harness
      && owned.session.providerVersion === interaction.providerVersion
  }

  async withInteractionOwner<T>(interaction: DurableInteraction, signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    const owned = this.ownedSessions.get(interaction.executionId)
    if (owned?.context.acceptedPlacement?.hostRef.kind !== 'device') return work(signal)
    if (owned.execution.runId !== interaction.runId) throw new DomainError(
      'INTERACTION_RUN_MISMATCH', 'The native interaction does not belong to this Run.', 409)
    signal.throwIfAborted()
    const controller = new AbortController()
    const retained = await this.retainRunOwner(owned.execution, () => controller.abort())
    try {
      const ownedSignal = AbortSignal.any([signal, controller.signal])
      ownedSignal.throwIfAborted()
      this.adoptRunOwner(retained.owner)
      return await work(ownedSignal)
    } finally { await retained.release() }
  }

  async attachInteraction(interaction: DurableInteraction, signal?: AbortSignal): Promise<AttachedInteractionSession> {
    if (interaction.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
    }
    const execution = await this.runs.getExecution(interaction.executionId)
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
    const execution = await this.runs.getExecution(context.executionId)
    if (!execution?.workingDirectory || !execution.runtimeDirectory || execution.agentId !== context.agentId
      || execution.workingDirectory !== context.workingDirectory
      || execution.nativeSessionId !== sessionReference.nativeSessionId || sessionReference.harness !== context.harness) {
      throw new Error('The native session ownership context does not match its durable execution.')
    }
    if (context.purpose === 'reviewer') {
      const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
      if (!configuration) throw new Error('The reviewer configuration is unavailable')
      const placementContext = await this.managerContext(execution, configuration)
      if (placementContext.acceptedPlacement?.hostRef.kind === 'device') {
        const controller = new AbortController()
        const { owner, release: releaseOwner } = await this.retainRunOwner(execution, () => controller.abort())
        try {
          await this.reviewerSessions.recoverRetainedReviewer(execution, owner, signal, context.reviewJob)
          const owned = this.ownedSessions.get(execution.id)
          if (!owned?.session || !owned.manager.retainsReviewerSession) throw new DomainError('REVIEWER_AUTHORITY_LOST',
            'The original remote reviewer is no longer resident.', 409)
          if (owned.reviewOwner) throw new DomainError('SESSION_LANE_BUSY', 'The reviewer already owns an active review.', 409)
          this.assertSessionIdentity(owned.session, sessionReference)
          owned.reviewOwner = owner
          owned.releaseReviewOwner = releaseOwner
          this.adoptRunOwner(owner)
          const combined = AbortSignal.any([owned.controller.signal, controller.signal, ...(signal ? [signal] : [])])
          if (context.reviewJob) {
            const credential = this.credentialLedger.get(owned.manager)
            if (!credential || !this.credentials?.bindReviewerJob) throw new DomainError('REVIEWER_CREDENTIAL_LOST',
              'The original reviewer credential cannot bind its current job.', 409)
            await this.credentials.bindReviewerJob(execution.id, credential, context.reviewJob)
          }
          await this.reviewerSessions.validateReviewer(owned, sessionReference, combined)
          return { manager: owned.manager, session: sessionReference, signal: combined }
        } catch (error) {
          const owned = this.ownedSessions.get(execution.id)
          if (owned?.releaseReviewOwner === releaseOwner) {
            delete owned.reviewOwner
            delete owned.releaseReviewOwner
          }
          await releaseOwner()
          throw error
        }
      }
    }
    const continuing = !this.ownedSessions.has(execution.id) && options.restartOwner
      ? await readRemoteWorkflowContinuation(options.restartOwner, execution) : undefined
    let recovery: Awaited<ReturnType<typeof readDetachedWorkflowLifetime>>
      | Awaited<ReturnType<typeof readRemoteWorkflowContinuation>> = undefined
    if (!this.ownedSessions.has(execution.id)) {
      const detached = options.restartOwner
        ? await this.detachedWorkflowSession(options.restartOwner, execution) : undefined
      if (continuing) this.assertSessionIdentity(continuing.session, sessionReference)
      else if (detached) this.assertSessionIdentity(detached, sessionReference)
      else if (execution.state !== 'completed' || !await this.workflowClosures?.read(execution)) throw new DomainError(
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
    const run = await this.runs.get(execution.runId)
    if (!run) throw new Error('The durable execution Run is unavailable.')
    if (run.executionState === 'completed') throw new Error('A completed Run cannot restart native work.')
    const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    if (!configuration || configuration.harness.harness !== context.harness) throw new Error('The durable execution configuration is unavailable or mismatched.')
    if (context.purpose === 'reviewer') {
      const previous = this.ownedSessions.get(execution.id)
      if (previous?.cleanup || previous?.reviewFinishing) throw new DomainError('SESSION_LANE_BUSY',
        'The captured reviewer lifetime is still closing.', 409)
      const native = await this.interactions.coordination.workflowSession(execution.id)
      if ((configuration.productRole !== 'master' && configuration.productRole !== 'orchestrator') || !isRunInProgress(run.executionState)
        || run.outcome !== 'pending' || execution.state !== 'completed' || !native?.finalized || run.approval?.handler !== 'orchestrator'
        || run.approval.designatedOrchestratorAgentId !== execution.agentId) {
        throw new DomainError('SESSION_LANE_BUSY', 'Workflow finalization must finish before review attachment.', 409)
      }
      this.assertSessionIdentity(native.session, sessionReference)
    } else if (execution.state === 'completed') {
      throw new DomainError('WORKER_EXECUTION_TERMINAL', 'A completed workflow execution cannot resume native work.', 409)
    }
    await this.validateContinuation?.(execution.id, signal)
    let request = this.ownedSessions.get(execution.id)?.context.workflowRequest
    if (!request) {
      request = await this.workflowRequest(execution, configuration, run, options.restartOwner)
    }
    const resolutionContext = {
      ...await this.managerContext(execution, configuration, context.purpose), workflowRequest: request,
    }
    if (this.stoppingRuns.has(execution.runId)) throw new Error('The Run is stopping.')
    const resolved = this.resolveManager(resolutionContext, options.restartOwner)
    const retryingAttachment = resolved.lifecycle === 'starting'
      && this.ownedSessions.get(execution.id)?.pendingApprovalRestoration
    // Claim outside cleanup: losing a concurrent startup race does not own its credentials.
    if (resolved.processState === 'needs_start' && !retryingAttachment) resolved.beginStart?.()
    const owned = this.lifecycle.ownSession(execution, resolutionContext, resolved.manager)
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
        if (!this.credentials?.restore || !resolved.manager.originalApplicationAccess) throw new DomainError(
          'NATIVE_CREDENTIAL_RECOVERY_REQUIRED', 'The original remote process credential cannot be restored.', 409)
        if (continuing.detached) {
          if (!this.workflowClosures) throw new DomainError('NATIVE_WORKFLOW_CLOSURE_CONFLICT',
            'The detached native lifetime cannot reserve its attachment.', 409)
          owned.closureRegistration = this.workflowClosures.begin(execution)
          owned.closureGeneration = await owned.closureRegistration
          if (owned.restartRecovery) owned.restartRecovery.attachmentGeneration = owned.closureGeneration
        }
        const session = await this.lifecycle.openingSession(owned, resolved.manager.attachSession(sessionReference,
          { kind: 'workflow', correlationId: `execution:${execution.id}`, request }, signal))
        this.assertSessionIdentity(sessionReference, session)
        const access = await resolved.manager.originalApplicationAccess(session, signal)
        const credential = await this.credentials.restore(execution.id, { agentId: execution.agentId,
          variables: { [APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]: access.token } })
        const current = await readRemoteWorkflowContinuation(options.restartOwner!, execution)
        const expected = { ...continuing, generation: owned.closureGeneration, detached: false }
        if (credential.principalId !== continuing.principalId || !isDeepStrictEqual(current, expected))
          throw new DomainError('NATIVE_CREDENTIAL_RECOVERY_REQUIRED', 'The original remote process lease changed.', 409)
        if (owned.closureGeneration) credential.nativeLifetimeGeneration = owned.closureGeneration
        this.credentialLedger.set(resolved.manager, credential)
        await this.validateContinuation?.(execution.id, signal)
        signal.throwIfAborted()
        resolved.markResident?.()
        return { manager: resolved.manager, session, signal: owned.controller.signal }
      }
      const environment = await this.prepareEnvironment(resolutionContext, resolved, {
        signal, ...(context.purpose === 'reviewer' ? { purpose: context.purpose } : {}), restartOwner: options.restartOwner,
      })
      await this.validateContinuation?.(execution.id, signal)
      options.restartOwner?.assertOwned()
      signal.throwIfAborted()
      if (resolved.processState === 'resident') {
        await resolved.manager.history(sessionReference, signal)
        return { manager: resolved.manager, session: sessionReference, signal: owned.controller.signal }
      }
      const session = await this.lifecycle.openingSession(owned, resolved.manager.attachSession(sessionReference, {
        kind: 'workflow', correlationId: context.correlationId ?? `execution:${execution.id}`, request,
        ...(context.nativeTurnId ? { nativeTurnId: context.nativeTurnId } : {}),
        ...(environment ? { environment } : {}),
      }, signal))
      this.assertSessionIdentity(sessionReference, session)
      resolved.markResident?.()
      signal.throwIfAborted()
      return { manager: resolved.manager, session, signal: owned.controller.signal }
    } catch (error) {
      const safe = nativePersistenceRedactor(this.credentialLedger.secrets(owned.manager))
      if (isRestartCancellation(error, signal)) throw safe.error(error)
      componentLogger('harness').warn({ err: safe.error(error), executionId: execution.id },
        'workflow approval attachment failed')
      if (isTransientExecutionError(error) || isTransientRefreshFailure(error) || isLeaseLost(error)
        || (error instanceof DomainError && error.code === 'SESSION_LANE_BUSY')) throw safe.error(error)
      resolved.markFailed?.()
      owned.failed = true
      if (options.restartOwner) throw safe.error(error)
      await this.lifecycle.cleanupSession(owned)
      throw safe.error(error)
    }
  }

  async restorePendingWorkflowApprovals(owner: RunOwnership, execution: HarnessExecution,
    pending: readonly DurableInteraction[], signal?: AbortSignal): Promise<boolean> {
    const resident = this.ownedSessions.get(execution.id)
    const detached = resident?.restartAttachment?.session ?? await this.detachedWorkflowSession(owner, execution)
      ?? (await readRemoteWorkflowContinuation(owner, execution))?.session
    if (!detached) return false
    if (detached.harness === 'opencode') {
      throw new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
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
      const owned = this.ownedSessions.get(execution.id)
      if (owned) {
        delete owned.pendingApprovalRestoration
        this.maintainWaitingWorkflowCredential(owned)
      }
      return true
    } catch (error) {
      owner.assertOwned()
      signal?.throwIfAborted()
      if (isTransientExecutionError(error) || isTransientRefreshFailure(error)) {
        const owned = this.ownedSessions.get(execution.id)
        if (owned) {
          owned.pendingApprovalRestoration = true
          if (!owned.openingFailed && owned.generation > 0) this.maintainWaitingWorkflowCredential(owned)
        }
        throw error
      }
      await this.runs.requestCleanup(owner.runId, owner)
      const owned = this.ownedSessions.get(execution.id)
      if (!owned) throw error
      const safe = nativePersistenceRedactor(this.credentialLedger.secrets(owned.manager))
      owned.controller.abort(error)
      // Dispose the attempted attachment; the cold registry still has to prove physical closure.
      await owned.manager.dispose()
      this.credentialLedger.delete(owned.manager)
      this.managers.release?.(owned.context, this.rawManagers.get(owned.manager) ?? owned.manager, 'failed')
      if (this.ownedSessions.get(execution.id) === owned) this.ownedSessions.delete(execution.id)
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
    const interaction = typeof id === 'string' ? await this.interactions.get(id) : undefined
    const configuration = await this.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    if (!interaction || interaction.deliveryState !== 'delivered'
      || !configuration || configuration.harness.harness !== interaction.harness
      || interaction.executionId !== execution.id || interaction.runId !== execution.runId
      || interaction.requestingAgentId !== execution.agentId
      || interaction.nativeSessionId !== execution.nativeSessionId) {
      throw new DomainError('GRAPH_INTERRUPT_RESUME_INVALID', 'The resume value is not a delivered interaction for this execution.', 409)
    }
  }

  async retainRunOwner(execution: HarnessExecution, onLost: () => void) {
    let owner = this.ownedSessions.get(execution.id)?.runOwner ?? this.sharedRunOwners.get(execution.runId)
    try { owner?.assertOwned() }
    catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'RUN_OWNERSHIP_LOST') throw error
      await owner?.release()
      owner = undefined
    }
    if (owner) {
      const release = owner.retain(onLost)
      runtimeTimingPoint('engine', 'run.retain_owner', {
        runId: execution.runId, executionId: execution.id, reused: true, success: true,
      })
      return { owner, release }
    }
    const acquired = await this.runs.acquireOwnership(execution.runId, onLost)
    runtimeTimingPoint('engine', 'run.retain_owner', {
      runId: execution.runId, executionId: execution.id, reused: false, success: Boolean(acquired),
    })
    if (!acquired) throw new DomainError('SESSION_LANE_BUSY', 'The Run is still completing its current native operation.', 409)
    return { owner: acquired, release: () => acquired.release() }
  }

  shareRunOwner(owner: RunOwnership): () => void {
    this.adoptRunOwner(owner)
    // Cold review attachment can start before recovery registers any session.
    this.sharedRunOwners.set(owner.runId, owner)
    return () => {
      if (this.sharedRunOwners.get(owner.runId) === owner) this.sharedRunOwners.delete(owner.runId)
    }
  }

  adoptRunOwner(owner: RunOwnership): void {
    owner.assertOwned()
    for (const owned of this.ownedSessions.values()) {
      if (owned.execution.runId !== owner.runId) continue
      owned.runOwner = owner
      this.managers.adoptOwner?.(owned.execution.id, this.rawManagers.get(owned.manager) ?? owned.manager, owner)
    }
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
    const claimed = await (await this.runs.repeat(input.owner)).claimWorkflowInput(execution.id)
    // The saved chat prompt was composed before this attempt prepared its browser; name the session it owns.
    const browserPrompt = claimed?.nativePrompt ? await this.collaboration?.readBrowserPrompt(input.owner, execution) : undefined
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
        await this.validateContinuation?.(observation.execution.id, observation.signal)
      }),
      assertBoundary: async () => {
        observation.signal.throwIfAborted()
        input.owner.assertOwned()
        await observation.bookkeeping(() => repeat.assertNativeBoundary(observation.execution.id))
        observation.signal.throwIfAborted()
        input.owner.assertOwned()
      },
      watchCredential: () => {
        const credential = observation.manager && this.credentialLedger.get(observation.manager)
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
    if (!this.credentials || observation.stopRenewal || !observation.manager! || !this.credentialLedger.has(observation.manager!)) return
    observation.stopRenewal = renewOwnedLeases({
      signal: observation.signal,
      check: async () => {
        observation.signal.throwIfAborted()
        input.owner.assertOwned()
        await this.validateContinuation?.(observation.execution.id, observation.signal)
        input.owner.assertOwned()
      },
      leases: [this.credentialLedger.lease(observation.manager!, async () => {
        const credential = this.credentialLedger.get(observation.manager!)
        if (!credential) throw new Error('The execution lost its native credential lease.')
        if (remainingCredentialLifetime(credential) <= WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) {
          await this.credentialLedger.renew(observation.manager!, observation.context!.executionId, {
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
          remainingMs: remainingCredentialLifetime(this.credentialLedger.get(observation.manager!)),
          err: observation.safeError(failure) }, 'Worker credential maintenance failed')
        observation.credentialFailure.abort(failure)
      },
    })
  }

  private async resumeWorkflowBudget(observation: WorkflowObservationState):
    Promise<ApprovalExecutionObservation | undefined> {
    try {
      await observation.bookkeeping(() => this.budgets.resume(observation.execution.id))
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
      await observation.bookkeeping(() => this.abandonAttempt(input.owner, observation.execution, failure))
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
    await observation.bookkeeping(() => this.budgets.ensure(
      observation.execution.id, input.graphThreadId, input.agentActiveTimeoutMs ?? this.activeTimeoutMs))
    const settled = await this.resumeWorkflowBudget(observation)
    if (settled) return settled
    if (input.workHandoffContract || input.deliverable) {
      observation.workResultRepairs = await observation.bookkeeping(() => this.runs.readWorkResultRepairAttempt(observation.execution.id, input.owner))
      observation.workflowCorrelation = workResultRepairCorrelation(observation.execution.id, observation.workResultRepairs)
    }
    const budgetStarted = performance.now()
    // An exhausted budget found on recovery takes the same deadline path as a
    // live timeout: abort, close the exact session and settle negatively.
    const remainingMs = await observation.bookkeeping(() => this.budgets.remaining(observation.execution.id)).catch((error: unknown) => {
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
      ? await observation.bookkeeping(() => this.interactions.getForExecution(observation.execution.id)) : undefined
    observation.request = HarnessExecutionRequestSchema.parse({
      ...input.request, executionId: observation.execution.id, runId: observation.execution.runId,
      workflowNodeId: observation.execution.workflowNodeId, workingDirectory: observation.execution.workingDirectory,
      runtimeDirectory: observation.execution.runtimeDirectory, systemPrompt: observation.execution.systemPrompt, input: observation.execution.input,
    })
    if (observation.request!.systemPrompt === undefined) delete observation.request!.systemPrompt
    observation.context = {
      ...await observation.bookkeeping(() => this.managerContext(observation.execution, input.request.configuration)),
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
      const resident = this.ownedSessions.get(observation.execution.id)
      if (resident) {
        assertSameRepeatExecution(observation.execution, resident.execution)
        if (resident.context.purpose === 'reviewer' || resident.cleanup || resident.reviewFinishing) {
          throw new DomainError('SESSION_LANE_BUSY', 'The exact native lifetime is finishing other work.', 409)
        }
        if (resident.session && observation.session!) this.assertSessionIdentity(resident.session, observation.session!)
      }
      if (!resident && observation.session!) {
        const continuing = observation.context!.acceptedPlacement?.hostRef.kind === 'device'
          ? await observation.bookkeeping(() => readRemoteWorkflowContinuation(input.owner, observation.execution)) : undefined
        const detached = continuing ? undefined : await this.detachedWorkflowSession(input.owner, observation.execution)
        if (continuing || detached) {
          this.assertSessionIdentity(continuing?.session ?? detached!, observation.session!)
          const recovery = continuing ?? await readDetachedWorkflowLifetime(input.owner, observation.execution)
          if (recovery) observation.restartRecovery = { ...recovery, owner: input.owner }
          await this.waitForRestartWriter(input.owner, observation.execution, observation.session!, observation.workflowCorrelation, continuing
            ? () => readRemoteWorkflowContinuation(input.owner, observation.execution)
            : () => readDetachedWorkflowLifetime(input.owner, observation.execution), observation.signal)
        }
      }
    }
    observation.resolved = this.resolveManager(observation.context!, input.owner)
    if (observation.resolved!.processState === 'needs_start') observation.resolved!.beginStart?.()
    observation.manager = observation.resolved!.manager
    observation.ownedSession = this.lifecycle.ownSession(observation.execution, observation.context!, observation.manager!)
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
    await observation.bookkeeping(() => this.runs.updateExecution(pendingExecution, input.owner, originalHistory))
    observation.execution = (await observation.bookkeeping(() => repeat.readExecution(pendingExecution.id))).execution
    ownedSession.execution = observation.execution
    const waiting: DurableInteraction[] = []
    for (const pending of history.pendingInteractions) {
      const interaction = await observation.bookkeeping(() => this.interactions.getNativeRequest(observation.execution.id, session.harness,
        session.nativeSessionId, pending.turn.nativeRequestId!))
      if (!interaction) throw new DomainError('APPROVAL_ORIGINAL_SOURCE_REQUIRED',
        'The owned native request publication did not commit.', 409)
      if (interaction.deliveryState !== 'delivered') waiting.push(interaction)
      await this.enqueueReview(interaction)
    }
    if (!waiting.length) return undefined
    observation.signal.throwIfAborted()
    this.maintainWaitingWorkflowCredential(ownedSession)
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
        this.prepareEnvironment(launchContext, launchManager, { signal: observation.signal, enterNative: async () => {
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
          await this.runs.updateExecution(observation.execution, input.owner, createdEvidence)
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
          await this.interactions.coordination.bindLaneTurn(lane.fence, correlationId)
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
          const opening = this.lifecycle.openingSession(ownedSession, observed)
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
          const observed = await this.lifecycle.openingSession(ownedSession,
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
          await observation.bookkeeping(() => this.budgets.assertActive(observation.execution.id))
          const lease = manager.currentProjectionLease(observation.session!)
          const frames = events.map((event) => {
            const original = observation.safeValue({ ...event, executionId: observation.execution.id })
            return { event: original, evidence: this.captureNative(input.owner, observation.execution,
              { type: 'event', event: original }, 'live', manager.capturedLease(observation.session!)) }
          })
          await timeRuntimeOperation('engine', 'native.persist_batch', async () => {
            const append = () => this.runs.appendNativeEvents(frames, input.owner, lease)
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
      if (observation.existing) this.assertSessionIdentity(observation.session!, observation.existing)
      const environment = await this.prepareEnvironment(context, resolved, { signal: observation.signal, restartOwner: input.owner })
      observation.startCredentialMaintenance()
      await observation.validateContinuation()
      observation.signal.throwIfAborted()
      input.owner.assertOwned()
      await observation.assertBoundary()
      if (resolved.processState === 'needs_start') {
        const attached = await this.lifecycle.openingSession(ownedSession, manager.attachSession(observation.session!, {
          kind: 'workflow', correlationId: observation.workflowCorrelation, request,
          ...(environment ? { environment } : {}),
        }, observation.signal))
        this.assertSessionIdentity(observation.session!, attached)
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
      await observation.bookkeeping(() => this.runs.appendNativeEvents(frames, observation.input.owner, lease))
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
    const reserved = await observation.bookkeeping(() => this.runs.reserveWorkResultRepair(
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
    await this.interactions.coordination.bindLaneTurn(lane.fence, observation.workflowCorrelation)
    lane.correlationId = observation.workflowCorrelation
    delete lane.providerId
    lane.observedStatus = 'uncertain'
    const acknowledge = async (providerId: string) => {
      await lane.guard.check()
      await observation.bookkeeping(() => this.interactions.coordination.acknowledgeLaneTurn(
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
      await observation.bookkeeping(() => this.budgets.assertActive(observation.execution.id))
      const original = observation.safeValue({ ...event, executionId: observation.execution.id })
      const evidence = this.captureNative(input.owner, observation.execution, { type: 'event', event: original }, 'live', lane)
      await observation.bookkeeping(() => this.runs.appendNativeEvent(original, input.owner,
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
    const owned = this.ownedSessions.get(execution.id)
    const safe = nativePersistenceRedactor(owned ? this.credentialLedger.secrets(owned.manager) : [])
    const history = safe.value(observed ?? await nativeManager.reconcile(session, original.correlationId, lane.guard.signal))
    assertOriginalWorkflowTerminal(execution, session, history, original.correlationId)
    if (!isDeepStrictEqual(history.terminalTurn!.result, original.nativeResult)) throw new DomainError(
      'NATIVE_TERMINAL_SOURCE_REQUIRED', 'Settlement differs from the already committed original result.', 409)
    lane.providerId = history.terminalTurn!.providerId
    await this.interactions.coordination.acknowledgeLaneTurn(lane.fence, original.correlationId, lane.providerId)
    const settled = nativeManager.settleTurn
      ? safe.value(await nativeManager.settleTurn(session, original.correlationId, lane.guard.signal)) : history
    assertOriginalWorkflowTerminal(execution, session, settled, original.correlationId)
    if (!isDeepStrictEqual(settled.terminalTurn, history.terminalTurn)) throw new DomainError(
      'NATIVE_TERMINAL_SOURCE_REQUIRED', 'The settled result differs from the original committed provider output.', 409)
    const captured = this.captureNative(owner, execution,
      { type: 'history', history: settled }, 'recovery', lane)
    await this.runs.publishWorkflowTerminalSettlement(execution, owner, captured)
    if (owned) owned.outputSettlementComplete = true
    await lane.guard.check()
  }

  private async settleRetainedWorkflowTerminal(execution: HarnessExecution, owner: RunOwnership,
    signal: AbortSignal): Promise<void> {
    const owned = this.ownedSessions.get(execution.id)
    // Cold cleanup uses the existing owner/process/artifact recovery path. A
    // completed execution must never attach or create a replacement manager.
    if (!owned?.session || owned.context.purpose === 'reviewer') return
    const original = await this.runs.readWorkflowTerminalSettlement(execution, owner)
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
        await observation.bookkeeping(() => this.budgets.assertActive(observation.execution.id))
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
          await observation.bookkeeping(() => this.interactions.coordination.acknowledgeLaneTurn(
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
              await observation.bookkeeping(() => this.runs.validateMemoryResult(
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
            this.runs.kanbanRecordMissing(observation.execution.id, observed.terminalTurn!.result, input.owner)) : undefined
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
              () => observation.bookkeeping(() => this.runs.updateExecution(completed, input.owner, captured)))
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
              const prompt = await this.collaboration?.effectRepairPrompt(input.owner, error)
              if (!prompt) throw error
              const repaired = await this.correctWorkflowResult(observation, nativeManager, lane, observed, captured, prompt)
              if (repaired.kind === 'waiting') return { waiting: repaired.observation }
              if (repaired.kind === 'repaired') continue
              throw error
            }
            await observation.bookkeeping(() => this.runs.updateExecution(completed, input.owner, captured, error))
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
              this.runs.readWorkflowTerminalSettlement(observation.execution, input.owner))
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
    const credential = observation.manager! && this.credentialLedger.get(observation.manager!)
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
      try { await this.budgets.beginWait(observation.execution.id) }
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
      if (repeatPhysicalSettlementPending(error)) await this.budgets.beginWait(observation.execution.id)
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
    if (observation.execution.state === 'completed' && (!observation.ownedSession! || this.closedExecutions.has(observation.execution.id))) throw error
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
          const failures = await this.lifecycle.cleanupSession(observation.ownedSession)
          if (failures.length) componentLogger('harness').warn({ executionId: observation.execution.id,
            failures: failures.length }, 'Closing a settled attempt remains unconfirmed')
        }
        throw error
      }
      if (repeatTickIndex(observation.execution.input) !== undefined && !input.signal.aborted) {
        await persist(() => this.failIntervalCheck(input.owner, observation.execution, failure))
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
          await this.abandonAttempt(input.owner, execution, transientExecutionFailure(error, fallbackCode))
        })
        throw error
      }
      await persist(() => this.runs.requestCleanup(observation.execution.runId, input.owner, failure,
        failure ? { executionId: observation.execution.id } : undefined))
      if (observation.ownedSession!) {
        observation.resolved?.markFailed?.()
        observation.ownedSession!.failed = true
        const failures = await this.lifecycle.cleanupSession(observation.ownedSession!)
        // The caught error may contain provider secrets; retain only its sanitized form.
        if (failures.length) throw new AggregateError(failures, 'Original native closure is still pending.', { cause: error })
      }
      await persist(() => this.budgets.stop(observation.execution.id))
      await persist(async () => (await this.runs.repeat(input.owner)).settleNegativeExecution(observation.execution.id,
        (await this.runs.getRepeatSnapshot(observation.execution.runId, input.owner)).stopRequested))
    } else if (observation.ownedSession!) {
      // An old owner may dispose its own captured transport only. It cannot
      // revoke a successor's credential, budget or execution authority.
      const owned = observation.ownedSession!
      const failures: Error[] = []
      await attemptCleanup(failures, 'close lost-owner transport', async signal => {
        if (owned.session) await this.lifecycle.closeWorkflowSession(owned, { restart: true, signal })
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
    if (this.ownedSessions.get(owned.execution.id) !== owned) return
    await owned.stopWaitingRenewal?.()
    if (this.ownedSessions.get(owned.execution.id) !== owned) return
    this.ownedSessions.delete(owned.execution.id)
    this.credentialLedger.delete(owned.manager)
    this.managers.release?.(owned.context, this.rawManagers.get(owned.manager) ?? owned.manager, 'released')
  }

}

/** What the extracted session collaborators read and call on the coordinator that owns them. */
export type ExecutionSessionHost = Pick<ApprovalExecutionCoordinator,
  | 'runs' | 'interactions' | 'budgets' | 'managers' | 'activeTimeoutMs' | 'credentials' | 'credentialLedger'
  | 'validateContinuation' | 'workflowClosures' | 'reviewNativeCaptures' | 'recoverNativeProcesses'
  | 'reserveNativeLaunch' | 'commitReviewNative' | 'collaboration' | 'reviewers'
  | 'ownedSessions' | 'closedExecutions' | 'closedWorkflowSessions' | 'stoppingRuns' | 'pendingCleanupRuns'
  | 'rawManagers' | 'closing' | 'workflowControls'
  | 'lifecycle' | 'consultations' | 'reviewerSessions' | 'cancellation'
  | 'executionCapacity' | 'adoptRunOwner' | 'assertSessionIdentity' | 'retainRunOwner' | 'managerContext'
  | 'resolveManager' | 'workflowRequest' | 'detachedWorkflowSession' | 'recoverExecutionControls'
  | 'recoverOutputSettlement' | 'restorePendingWorkflowApprovals'>

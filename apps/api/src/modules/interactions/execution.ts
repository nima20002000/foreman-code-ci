import type { ExecutionLimiter } from '../runs/limiter.js'
import { RunExecutionCapacity } from './executionCapacity.js'
import { NativeCredentialLedger } from './nativeCredentialLedger.js'
import { ExecutionSessionLifecycle } from './executionSessionLifecycle.js'
import { ExecutionConsultations } from './executionConsultations.js'
import { ExecutionReviewerSessions } from './executionReviewerSessions.js'
import { ExecutionCancellation } from './executionCancellation.js'
import type { InteractionActivityEvidence } from './activityProjection.js'
import type { ReviewNativeCapture, ReviewNativeCapturePort, ReviewOriginalNativeSource } from './reviewNativeCapture.js'
import { type DurableInteraction, type ExecutionResult, type HarnessExecution, type HarnessExecutionRequest, type NativeSessionReference, type PendingNativeInteraction, type ReviewJob } from '@foreman-code/contracts'
import type { NativeHarnessSessionManager } from '../harnesses/port.js'
import { DomainError } from '../errors.js'
import type { WorkflowCollaborationIntegration } from '../collaboration/workflowIntegration.js'
import type { WorkflowChatOwnerPort } from '../collaboration/workflowControlTypes.js'
import type { createWorkflowChatOwner } from './workflowChatOwner.js'
import { ReviewerDispatcher } from './reviewer.js'
import type { ReviewCleanupSession, ReviewCredentialMaintenance } from './reviewerRuntime.js'
import type { PostgresRunRepository } from '../runs/postgres.js'
import type { RunOwnership } from '../runs/ownership.js'
import type { RepeatNativeEvidence } from '../runs/repeatNativeRepository.js'
import type { SessionWriteLease } from './sessionWriter.js'
import type { PostgresApprovalBudgetRepository } from './budget.js'
import type { CurrentInteractionRepository as PostgresInteractionRepository } from './current/repository.js'
import type { AttachedInteractionSession, NativeManagerResolutionContext, NativeManagerOwnershipContext, NativeSessionManagerResolver } from './runtimePorts.js'
import type { ExecutionCredentialProvider } from '../harnesses/mcpDetection.js'
import { type ClosedWorkflowSession, type WorkflowClosureStore } from './workflowClosure.js'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { type RepeatNativeObservationStore } from './repeatObservation.js'
import { ExecutionSessionAttachment } from './executionSessionAttachment.js'
import { ExecutionWorkflowObservation } from './executionWorkflowObservation.js'
import { ExecutionWorkflowControls } from './executionWorkflowControls.js'
import type { ApprovalExecutionDependencies, ApprovalExecutionObservation, ApprovalObservationInput, ExecutionSessionHost, OwnedNativeSession } from './executionSessionHost.js'
export type { ApprovalExecutionDependencies, ApprovalExecutionObservation, CurrentApprovalExecutionDependencies, OwnedNativeSession } from './executionSessionHost.js'

/** Idempotent ensure/observe boundary called first on every LangGraph node entry. */
export class ApprovalExecutionCoordinator {
  private readonly credentialLedger: NativeCredentialLedger
  private readonly capacity = new RunExecutionCapacity()

  readonly reviewers: ReviewerDispatcher
  private readonly lifecycle: ExecutionSessionLifecycle
  private readonly consultations: ExecutionConsultations
  private readonly reviewerSessions: ExecutionReviewerSessions
  private readonly cancellation: ExecutionCancellation
  private readonly attachment: ExecutionSessionAttachment
  private readonly observation: ExecutionWorkflowObservation
  private readonly controls: ExecutionWorkflowControls
  get reviewCoordination() { return this.interactions.coordination }
  private readonly rawManagers = new WeakMap<NativeHarnessSessionManager, NativeHarnessSessionManager>()
  // A waiting graph has no active task, but still owns its native process.
  private readonly ownedSessions = new Map<string, OwnedNativeSession>()
  private readonly closedExecutions = new Set<string>()
  // Closure survives the early ownerless Stop pass, but never a new connection.
  private readonly closedWorkflowSessions = new Map<string, ClosedWorkflowSession>()
  private readonly stoppingRuns = new Set<string>()
  private readonly pendingCleanupRuns = new Set<string>()
  private readonly sharedRunOwners = new Map<string, RunOwnership>()
  private workflowControls: ReturnType<typeof createWorkflowChatOwner> | undefined
  private closing = false

  executionCapacity(runId: string, maximum: number): ExecutionLimiter { return this.capacity.limiter(runId, maximum) }

  residentRunIds(): string[] {
    return [...new Set([...this.pendingCleanupRuns, ...[...this.ownedSessions.values()].map((owned) => owned.execution.runId)])]
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

  private readonly runs: PostgresRunRepository
  private readonly interactions: PostgresInteractionRepository
  private readonly budgets: PostgresApprovalBudgetRepository
  private readonly managers: NativeSessionManagerResolver
  private readonly activeTimeoutMs: number
  private readonly credentials: ExecutionCredentialProvider | undefined
  private readonly validateContinuation: ApprovalExecutionDependencies['validateContinuation']
  private readonly workflowClosures: WorkflowClosureStore | undefined
  private readonly reviewNativeCaptures: ReviewNativeCapturePort | undefined
  private readonly recoverNativeProcesses: ApprovalExecutionDependencies['recoverNativeProcesses']
  private readonly reserveNativeLaunch: ApprovalExecutionDependencies['reserveNativeLaunch']
  private readonly commitReviewNative: ApprovalExecutionDependencies['commitReviewNative']
  private readonly collaboration: WorkflowCollaborationIntegration | undefined

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
    this.reviewNativeCaptures = dependencies.reviewNativeCaptures
    this.recoverNativeProcesses = dependencies.recoverNativeProcesses
    this.reserveNativeLaunch = dependencies.reserveNativeLaunch
    this.commitReviewNative = dependencies.commitReviewNative
    this.collaboration = dependencies.collaboration
    this.reviewers = new ReviewerDispatcher(this.interactions.coordination, this)
    const coordinator = this
    const host: ExecutionSessionHost = {
      ...dependencies,
      get credentialLedger() { return coordinator.credentialLedger },
      get reviewers() { return coordinator.reviewers },
      get lifecycle() { return coordinator.lifecycle },
      get consultations() { return coordinator.consultations },
      get reviewerSessions() { return coordinator.reviewerSessions },
      get cancellation() { return coordinator.cancellation },
      get rawManagers() { return coordinator.rawManagers },
      get ownedSessions() { return coordinator.ownedSessions },
      get closedExecutions() { return coordinator.closedExecutions },
      get closedWorkflowSessions() { return coordinator.closedWorkflowSessions },
      get stoppingRuns() { return coordinator.stoppingRuns },
      get pendingCleanupRuns() { return coordinator.pendingCleanupRuns },
      get sharedRunOwners() { return coordinator.sharedRunOwners },
      get workflowControls() { return coordinator.workflowControls },
      get closing() { return coordinator.closing },
      get runs() { return coordinator.runs },
      get interactions() { return coordinator.interactions },
      get budgets() { return coordinator.budgets },
      get managers() { return coordinator.managers },
      get activeTimeoutMs() { return coordinator.activeTimeoutMs },
      get credentials() { return coordinator.credentials },
      get validateContinuation() { return coordinator.validateContinuation },
      get workflowClosures() { return coordinator.workflowClosures },
      get reviewNativeCaptures() { return coordinator.reviewNativeCaptures },
      get recoverNativeProcesses() { return coordinator.recoverNativeProcesses },
      get reserveNativeLaunch() { return coordinator.reserveNativeLaunch },
      get commitReviewNative() { return coordinator.commitReviewNative },
      get collaboration() { return coordinator.collaboration },
      set closing(value) { coordinator.closing = value },
      set workflowControls(value) { coordinator.workflowControls = value },
      executionCapacity: (...args) => this.executionCapacity(...args),
      releaseExecutionCapacity: (...args) => this.capacity.release(...args),
      adoptRunOwner: (...args) => this.adoptRunOwner(...args),
      retainRunOwner: (...args) => this.lifecycle.retainRunOwner(...args),
      assertSessionIdentity: (...args) => this.attachment.assertSessionIdentity(...args),
      managerContext: (...args) => this.attachment.managerContext(...args),
      resolveManager: (...args) => this.attachment.resolveManager(...args),
      workflowRequest: (...args) => this.attachment.workflowRequest(...args),
      prepareEnvironment: (...args) => this.attachment.prepareEnvironment(...args),
      maintainWaitingWorkflowCredential: (...args) => this.attachment.maintainWaitingWorkflowCredential(...args),
      detachedWorkflowSession: (...args) => this.attachment.detachedWorkflowSession(...args),
      waitForRestartWriter: (...args) => this.attachment.waitForRestartWriter(...args),
      restorePendingWorkflowApprovals: (...args) => this.attachment.restorePendingWorkflowApprovals(...args),
      recoverExecutionControls: (...args) => this.controls.recoverExecutionControls(...args),
      recoverOutputSettlement: (...args) => this.observation.recoverOutputSettlement(...args),
      enqueueReview: (...args) => this.enqueueReview(...args),
      failIntervalCheck: (...args) => this.failIntervalCheck(...args),
      abandonAttempt: (...args) => this.abandonAttempt(...args),
      finishIdleReviewers: (...args) => this.finishIdleReviewers(...args),
    }
    this.lifecycle = new ExecutionSessionLifecycle(host)
    this.consultations = new ExecutionConsultations(host)
    this.reviewerSessions = new ExecutionReviewerSessions(host)
    this.cancellation = new ExecutionCancellation(host)
    this.attachment = new ExecutionSessionAttachment(host)
    this.observation = new ExecutionWorkflowObservation(host)
    this.controls = new ExecutionWorkflowControls(host)
  }

  /** Production builds this coordinator from CurrentApprovalExecutionDependencies, so every native port is present. */
  assertCurrentProduction(runs: PostgresRunRepository): void {
    if (this.runs !== runs) throw new DomainError(
      'CURRENT_NATIVE_COMPOSITION_REQUIRED', 'The coordinator must use the current production Run repository.', 503)
    this.interactions.coordination.assertOriginalNativeComposition()
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
    return this.lifecycle.finishRun(runId)
  }

  async nativeBoundaryEvidence(executionId: string, owner: RunOwnership): Promise<RepeatNativeEvidence> {
    return this.observation.nativeBoundaryEvidence(executionId, owner)
  }

  async enqueueReview(interaction: DurableInteraction): Promise<void> {
    return this.reviewerSessions.enqueueReview(interaction)
  }

  async reconcileReviews(onError: (error: unknown) => void): Promise<void> {
    return this.reviewerSessions.reconcileReviews(onError)
  }

  async withSourceObservationLane<T>(owner: RunOwnership, execution: HarnessExecution, work: () => Promise<T>): Promise<T> {
    return this.attachment.withSourceObservationLane(owner, execution, work)
  }

  passiveOwnedNativeSessions() {
    return this.attachment.passiveOwnedNativeSessions()
  }

  workflowChatOwner(sql: SqlQuery,
    validateAdmission: WorkflowChatOwnerPort['validateAdmission']) {
    return this.controls.workflowChatOwner(sql, validateAdmission)
  }

  async reconcileWorkflowControls(onError: (error: unknown) => void): Promise<void> {
    return this.controls.reconcileWorkflowControls(onError)
  }

  async inspectInteractionActivity(interaction: DurableInteraction): Promise<InteractionActivityEvidence> {
    return this.attachment.inspectInteractionActivity(interaction)
  }

  async validateInteraction(interaction: DurableInteraction, signal?: AbortSignal): Promise<void> {
    return this.attachment.validateInteraction(interaction, signal)
  }

  hasOriginalRequester(interaction: DurableInteraction): boolean {
    return this.attachment.hasOriginalRequester(interaction)
  }

  async withInteractionOwner<T>(interaction: DurableInteraction, signal: AbortSignal,
    work: (signal: AbortSignal) => Promise<T>): Promise<T> {
    return this.attachment.withInteractionOwner(interaction, signal, work)
  }

  async attachInteraction(interaction: DurableInteraction, signal?: AbortSignal): Promise<AttachedInteractionSession> {
    return this.attachment.attachInteraction(interaction, signal)
  }

  async attachOwnedSession(
    context: NativeManagerOwnershipContext,
    sessionReference: { harness: NativeManagerResolutionContext['harness']; providerVersion: string; nativeSessionId: string },
    signal?: AbortSignal,
  ): Promise<AttachedInteractionSession> {
    return this.attachment.attachOwnedSession(context, sessionReference, signal)
  }

  async assertResume(execution: HarnessExecution, value: unknown): Promise<void> {
    return this.attachment.assertResume(execution, value)
  }

  shareRunOwner(owner: RunOwnership): () => void {
    return this.lifecycle.shareRunOwner(owner)
  }

  adoptRunOwner(owner: RunOwnership): void {
    return this.lifecycle.adoptRunOwner(owner)
  }

  async observeExact(input: Omit<ApprovalObservationInput, 'candidate' | 'request'> & {
    execution: HarnessExecution; request?: HarnessExecutionRequest; store: RepeatNativeObservationStore
  }): Promise<ApprovalExecutionObservation> {
    return this.observation.observeExact(input)
  }
}

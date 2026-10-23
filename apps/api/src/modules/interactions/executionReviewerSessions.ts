import type { ReviewNativeCapture, ReviewOriginalNativeSource } from './reviewNativeCapture.js'
import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import type { DurableInteraction, HarnessExecution, NativeSessionReference, PendingNativeInteraction, ReviewJob } from '@foreman-code/contracts'
import { remainingCredentialLifetime } from '../access/credentialLifetime.js'
import { WORKER_CREDENTIAL_RENEWAL_WINDOW_MS } from '../access/workerCredentials.js'
import { DomainError } from '../errors.js'
import { nativePersistenceRedactor } from './nativePersistence.js'
import type { ReviewCleanupSession, ReviewCredentialMaintenance } from './reviewerRuntime.js'
import { isLeaseLost } from './sessionWriter.js'
import { isTransientRefreshFailure, renewOwnedLeases } from '../leases/ownerLeases.js'
import type { RunOwnership } from '../runs/ownership.js'
import type { SessionWriteLease } from './sessionWriter.js'
import { readRecoverableRemoteReviewer, readRetainedRemoteReviewer, retainRemoteReviewerCredential } from './retainedRemoteReviewer.js'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { reviewPreflightIdentity } from './reviewPolicy.js'
import { assertSameReviewJob, reviewPhysicallySettled } from './repeatObservation.js'
import { isRunInProgress } from '../runs/runState.js'
import { isRestartCancellation } from './executionPredicates.js'
import type { ExecutionSessionHost, OwnedNativeSession } from './executionSessionHost.js'

/** Reviewer native sessions: credential upkeep, capture, retained-reviewer recovery and idle finish. */
export class ExecutionReviewerSessions {
  private readonly reviewerRecoveries = new Map<string, Promise<boolean>>()
  constructor(private readonly host: ExecutionSessionHost) {}

  /** The in-flight retained-reviewer recovery of one execution, if any. */
  recovery(executionId: string): Promise<boolean> | undefined { return this.reviewerRecoveries.get(executionId) }

  /** The execution credential as one lease of its owner; Worker relays and launcher routes follow its expiry. */
  /** Snapshot the owned process values before a terminal cleanup can discard them. */
  reviewPersistence(executionId: string) {
    const owned = this.host.ownedSessions.get(executionId)
    const credential = owned && this.host.credentialLedger.get(owned.manager)
    if (this.host.credentials && !credential) throw new DomainError('REVIEWER_CREDENTIAL_LOST',
      'Native persistence requires the exact process credential redaction context.', 409)
    return nativePersistenceRedactor(Object.values(credential?.environment.variables ?? {}))
  }

  captureReviewNative(executionId: string, session: NativeSessionReference, job: ReviewJob,
    lane: SessionWriteLease, source: ReviewOriginalNativeSource): ReviewNativeCapture {
    const owned = this.host.ownedSessions.get(executionId)
    if (!owned?.session || !owned.closureGeneration || !this.host.reviewNativeCaptures
      || owned.context.purpose !== 'reviewer') throw new DomainError('REVIEW_ORIGINAL_SOURCE_REQUIRED',
      'The designated reviewer has no captured original native lifetime.', 409)
    const generation = owned.generation, manager = owned.manager
    const check = () => {
      if (this.host.ownedSessions.get(executionId) !== owned || owned.manager !== manager
        || owned.generation !== generation || owned.opening || !owned.session
        || source.type === 'entry' && (owned.controller.signal.aborted || this.host.stoppingRuns.has(owned.execution.runId))) {
        throw new DomainError('REVIEWER_AUTHORITY_LOST', 'The original review native lifetime is no longer current.', 409)
      }
      this.host.assertSessionIdentity(owned.session, session)
    }
    check()
    return this.host.reviewNativeCaptures.capture({ execution: owned.execution, session, job, manager, lease: lane,
      ...(owned.reviewOwner ? { owner: owned.reviewOwner } : {}),
      lifetimeGeneration: generation, closureGeneration: owned.closureGeneration, source, assertCurrent: check })
  }

  reviewCredentialIdentity(executionId: string, session: NativeSessionReference): { required: boolean; principalId?: string } {
    const owned = this.host.ownedSessions.get(executionId)
    if (owned?.session) this.host.assertSessionIdentity(owned.session, session)
    const credential = owned && this.host.credentialLedger.get(owned.manager)
    return { required: Boolean(this.host.credentials), ...(credential ? { principalId: credential.principalId } : {}) }
  }

  async revokeReviewCredential(principalId: string): Promise<void> {
    if (!this.host.credentials) throw new Error('The captured reviewer credential cannot be revoked without its provider.')
    // The durable job stores only the captured principal, not a reusable token.
    // Never revokeForExecution here: a successor may own a different principal.
    await this.host.credentials.revoke({ principalId })
  }

  async recoverReviewCleanup(executionId: string, session: NativeSessionReference, job: ReviewJob,
    signal: AbortSignal): Promise<ReviewCleanupSession> {
    signal.throwIfAborted()
    const execution = await this.host.runs.getExecution(executionId)
    const native = await this.host.interactions.coordination.workflowSession(executionId)
    const configuration = execution && await this.host.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    if (!job.cleanup || job.state !== 'failed' || !execution || execution.agentId !== job.reviewerAgentId
      || execution.nativeSessionId !== job.nativeSessionId || session.nativeSessionId !== job.nativeSessionId
      || session.harness !== job.provider || !native?.finalized || !configuration
      || configuration.harness.harness !== job.provider || configuration.agentId !== job.reviewerAgentId) {
      throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'Cleanup does not match the durable reviewer execution.', 409)
    }
    this.host.assertSessionIdentity(native.session, session)
    signal.throwIfAborted()
    const owned = this.host.ownedSessions.get(executionId)
    if (owned?.session) this.host.assertSessionIdentity(owned.session, session)
    const context = await this.host.managerContext(execution, configuration, 'reviewer')
    const resolved = owned ? undefined : this.host.resolveManager(context)
    const manager = owned?.manager ?? resolved!.manager
    // Resolving a writer is not starting/attaching it. In particular there is no
    // prepareEnvironment, beginStart, capabilities, or credential heartbeat here.
    const resident = owned ? Boolean(owned.session && !owned.opening) : resolved!.processState === 'resident'
    return {
      manager, resident, closed: this.host.closedExecutions.has(executionId),
      confirmClosed: async (cleanupSignal) => {
        cleanupSignal.throwIfAborted()
        const proof = await this.host.workflowClosures?.read(execution)
        cleanupSignal.throwIfAborted()
        if (!proof) return false
        this.host.assertSessionIdentity(proof.session, session)
        // The receipt already proves original close and every older generation.
        // Neither process absence nor a new manager's empty map is consulted.
        return true
      },
    }
  }

  async validateReviewer(owned: OwnedNativeSession, session: NativeSessionReference, signal: AbortSignal): Promise<void> {
    signal.throwIfAborted()
    if (this.host.ownedSessions.get(owned.execution.id) !== owned || owned.context.purpose !== 'reviewer'
      || owned.controller.signal.aborted || this.host.stoppingRuns.has(owned.execution.runId)) {
      throw new DomainError('REVIEWER_AUTHORITY_LOST', 'The reviewer no longer owns this native process.', 409)
    }
    const execution = await this.host.runs.getExecution(owned.execution.id)
    const run = await this.host.runs.get(owned.execution.runId)
    const native = await this.host.interactions.coordination.workflowSession(owned.execution.id)
    const configuration = execution && await this.host.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    signal.throwIfAborted()
    if (!execution || execution.state !== 'completed' || execution.agentId !== owned.context.agentId
      || execution.runId !== owned.execution.runId || execution.nativeSessionId !== session.nativeSessionId
      || execution.agentConfigurationVersionId !== owned.execution.agentConfigurationVersionId
      || execution.workingDirectory !== owned.context.workingDirectory
      || execution.runtimeDirectory !== owned.execution.runtimeDirectory
      || !run || run.id !== owned.execution.runId || !isRunInProgress(run.executionState) || run.outcome !== 'pending'
      || run.approval?.handler !== 'orchestrator' || run.approval.designatedOrchestratorAgentId !== execution.agentId
      || !configuration || (configuration.productRole !== 'master' && configuration.productRole !== 'orchestrator')
      || configuration.agentId !== execution.agentId
      || configuration.id !== execution.agentConfigurationVersionId || configuration.workspaceId !== run.workspaceId
      || configuration.harness.harness !== session.harness || !native?.finalized) {
      throw new DomainError('REVIEWER_AUTHORITY_LOST', 'The Run or finalized reviewer execution no longer authorizes this review.', 409)
    }
    this.host.assertSessionIdentity(native.session, session)
    await this.host.validateContinuation?.(execution.id, signal)
    signal.throwIfAborted()
  }

  async maintainReviewCredential(executionId: string, session: NativeSessionReference, parentSignal: AbortSignal,
    assertOwned: () => Promise<void>): Promise<ReviewCredentialMaintenance> {
    const owned = this.host.ownedSessions.get(executionId)
    if (!owned) throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The reviewer native process is no longer owned.', 409)
    const initial = this.host.credentialLedger.get(owned.manager)
    const generation = owned.generation
    if (this.host.credentials && !initial) throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The reviewer credential is no longer owned.', 409)
    const stopped = new AbortController()
    const failed = new AbortController()
    const signal = AbortSignal.any([parentSignal, owned.controller.signal, stopped.signal, failed.signal])
    const check = async () => {
      signal.throwIfAborted()
      await assertOwned()
      if (owned.generation !== generation || owned.opening) throw new DomainError('REVIEWER_AUTHORITY_LOST',
        'The native reviewer connection changed during credential maintenance.', 409)
      await this.validateReviewer(owned, session, signal)
      await assertOwned()
      signal.throwIfAborted()
    }
    let invalidation: Promise<void> | undefined
    const invalidate = () => {
      // No revokeForExecution: a successor may already own a different principal.
      invalidation ??= (initial && this.host.credentials ? this.host.credentials.revoke(initial) : Promise.resolve())
        .catch((error: unknown) => { invalidation = undefined; throw error })
      return invalidation
    }
    // Initial authority reads can stall too. Do not wait past the process token's
    // safety deadline before publishing a fail-closed handle to the dispatcher.
    const preflightDeadline = initial ? setTimeout(() => failed.abort(new DomainError('REVIEWER_CREDENTIAL_LOST',
      'Reviewer credential authority validation exceeded its safety deadline.', 409)),
    Math.max(0, remainingCredentialLifetime(initial) - 5_000)) : undefined
    preflightDeadline?.unref()
    let abortPreflight: (() => void) | undefined
    try {
      await Promise.race([check(), new Promise<never>((_resolve, reject) => {
        abortPreflight = () => reject(signal.reason)
        signal.addEventListener('abort', abortPreflight, { once: true })
        if (signal.aborted) abortPreflight()
      })])
    } catch (error) {
      if (isLeaseLost(error) || parentSignal.aborted || owned.controller.signal.aborted) throw error
      // Return the captured owner handle even on failed preflight, so dispatch
      // can persist the failure and cancel/revoke without guessing an owner.
      const failure = new DomainError('REVIEWER_CREDENTIAL_LOST',
        'The reviewer authority could not be confirmed before credential maintenance.', 409)
      failure.cause = error
      failed.abort(failure)
    } finally {
      clearTimeout(preflightDeadline)
      if (abortPreflight) signal.removeEventListener('abort', abortPreflight)
    }
    const stopRenewal = !signal.aborted && initial && this.host.credentials ? renewOwnedLeases({
      signal,
      check,
      leases: [this.host.credentialLedger.lease(owned.manager, async () => {
        const credential = this.host.credentialLedger.get(owned.manager)
        if (!credential || credential.principalId !== initial.principalId || credential.environment !== initial.environment
          || !Number.isFinite(remainingCredentialLifetime(credential)) || remainingCredentialLifetime(credential) <= 0) {
          throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The reviewer lost its live process credential.', 409)
        }
        if (remainingCredentialLifetime(credential) <= WORKER_CREDENTIAL_RENEWAL_WINDOW_MS) {
          await this.host.credentialLedger.renew(owned.manager, executionId, { check, signal })
        }
      })],
      onFailure: (error) => {
        // Lease loss must remain distinguishable: it cannot cancel a successor's native turn.
        if (isLeaseLost(error)) {
          failed.abort(error)
          return
        }
        const failure = new DomainError('REVIEWER_CREDENTIAL_LOST',
          'Review stopped because its App MCP credential or authority could not be maintained. No native work was restarted.', 409)
        failure.cause = error
        failed.abort(failure)
        void invalidate().catch(() => {
          // ignore: invalidation already reports its failure through the retained cleanup state.
        })
      },
    }) : undefined
    return { signal, invalidate, ...(initial ? { principalId: initial.principalId } : {}),
      stop: async () => { stopped.abort(); await stopRenewal?.() } }
  }

  async recordReviewFailure(executionId: string, job: ReviewJob, error: NonNullable<ReviewJob['error']>,
    pending?: PendingNativeInteraction, pendingRequests?: readonly PendingNativeInteraction[]): Promise<void> {
    const owned = this.host.ownedSessions.get(executionId)
    if (!owned || owned.execution.agentId !== job.reviewerAgentId || owned.session?.nativeSessionId !== job.nativeSessionId) {
      throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'The failure does not belong to this reviewer execution.', 409)
    }
    // The owning review-job writer persists the sanitized negative disposition.
    // This callback validates identity only; it cannot manufacture native proof.
    void error; void pending; void pendingRequests
  }

  async prepareReviewTurn(executionId: string, session: NativeSessionReference, job: ReviewJob,
    lane: SessionWriteLease, signal: AbortSignal): Promise<void> {
    const owned = this.host.ownedSessions.get(executionId)
    if (!owned?.manager.retainsReviewerSession) return
    const credential = this.host.credentialLedger.get(owned.manager)
    if (!credential || !this.host.credentials?.bindReviewerJob || !owned.reviewOwner)
      throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The original reviewer process lease is unavailable.', 409)
    owned.reviewOwner.assertOwned()
    await this.host.credentials.bindReviewerJob(executionId, credential, job, lane)
    await owned.manager.prepareReview(session, job, signal)
    await lane.guard.check()
  }

  async releaseReviewSession(executionId: string): Promise<void> {
    const owned = this.host.ownedSessions.get(executionId)
    const release = owned?.releaseReviewOwner
    try { await this.afterReviewCommit(executionId) }
    finally {
      if (owned) {
        delete owned.reviewOwner
        delete owned.releaseReviewOwner
      }
      await release?.()
    }
  }

  afterReviewCommit(executionId: string): Promise<void> {
    return this.host.commitReviewNative?.(executionId) ?? Promise.resolve()
  }

  /** Capture at reviewer attachment, not in its eventual finally callback. The
   * marker also distinguishes two jobs reusing the same resident connection. */
  captureReviewFinalizer(executionId: string, session: NativeSessionReference, assigned: ReviewJob):
    ((settled: ReviewJob) => Promise<void>) | undefined {
    // Do not let a mutable dispatch argument retarget the captured identity.
    assigned = { ...assigned }
    session = { ...session }
    const owned = this.host.ownedSessions.get(executionId)
    if (!owned?.session) return undefined
    this.host.assertSessionIdentity(owned.session, session)
    if (owned.context.purpose !== 'reviewer' || owned.execution.agentId !== assigned.reviewerAgentId
      || session.harness !== assigned.provider || session.nativeSessionId !== assigned.nativeSessionId) {
      throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'The reviewer finalizer has no captured assignment.', 409)
    }
    const generation = owned.generation
    const marker = Symbol(assigned.id)
    owned.reviewFinalizer = marker
    // Stop, ownership loss or credential loss can close or tear down this same lifetime while the review ends.
    // That path then owns the closure, so the finalizer has nothing left to do and must not report a conflict.
    let yielded: DomainError | undefined
    const check = () => {
      if (this.host.ownedSessions.get(executionId) !== owned || owned.generation !== generation
        || owned.reviewFinalizer !== marker || owned.opening || owned.controller.signal.aborted) {
        const lost = new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'The reviewer finalizer lost its native lifetime.', 409)
        const registered = this.host.ownedSessions.get(executionId)
        if (owned.generation === generation && owned.reviewFinalizer === marker && !owned.opening
          && (registered === undefined || registered === owned)) yielded = lost
        throw lost
      }
      this.host.assertSessionIdentity(owned.session!, session)
    }
    const finalize = async (settled: ReviewJob) => {
      assertSameReviewJob(assigned, settled)
      check()
      const run = await this.host.runs.get(owned.execution.runId)
      check()
      if (!run) throw new DomainError('RUN_NOT_FOUND', 'The captured reviewer Run is unavailable.', 404)
      if (!reviewPhysicallySettled(settled)) return
      owned.reviewFinishing = true
      try {
        const context = await this.host.interactions.coordination.getReviewJobContext(assigned.id)
        check()
        if (context.executionId !== executionId || context.workingDirectory !== owned.context.workingDirectory
          || context.providerVersion !== session.providerVersion) throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT',
          'The review job no longer names the captured execution and provider.', 409)
        // The same native writer lane fences a successor in another process.
        await owned.manager.withLane(session, assigned.correlationId, undefined, async (_manager, lane) => {
          const guard = async () => { check(); await lane.guard.check(); check() }
          await guard()
          const current = await this.host.interactions.coordination.findReviewJob(assigned.interactionId, assigned.reviewerAgentId)
          await guard()
          if (!current) throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'The captured review job is missing.', 409)
          assertSameReviewJob(settled, current)
          if (!reviewPhysicallySettled(current) || current.state !== settled.state) throw new DomainError(
            'REPEAT_CLEANUP_PENDING', 'The exact reviewer terminal receipt is not settled.', 409)
          await this.host.interactions.coordination.assertReviewPhysicalSettlement(current, executionId)
          await guard()
          const notStarted = current.state === 'failed' && current.cleanup?.nativeState === 'not_started'
          if (lane.previous.correlationId !== assigned.correlationId
            && !(notStarted && lane.previous.correlationId === `execution:${executionId}`)
            || current.providerTurnOrMessageId && lane.previous.currentTurnOrMessageId !== current.providerTurnOrMessageId) {
            throw new DomainError('REVIEW_JOB_IDENTITY_CONFLICT', 'The captured review no longer owns the native turn.', 409)
          }
          // A sibling's queued/uncertain review remains responsible for this
          // session. It is not closed under an earlier job's callback.
          if (await this.host.interactions.coordination.hasUnsettledReview(executionId)) return
          const currentRun = await this.host.runs.get(owned.execution.runId)
          await guard()
          if (owned.manager.retainsReviewerSession && currentRun && isRunInProgress(currentRun.executionState)
            && currentRun.outcome === 'pending') return
          await guard()
          await this.host.lifecycle.closeRepeatLifetime(owned, check)
          lane.observedStatus = 'idle'
          await lane.guard.check()
        })
      } finally { if (owned.reviewFinalizer === marker) delete owned.reviewFinishing }
    }
    return async (settled) => {
      try { await finalize(settled) } catch (error) {
        if (yielded && error === yielded) return
        throw error
      }
    }
  }

  maintainRetainedReviewer(owned: OwnedNativeSession): void {
    if (owned.stopReviewerRenewal || !this.host.credentials?.renew) return
    owned.stopReviewerRenewal = renewOwnedLeases({
      signal: owned.controller.signal,
      leases: [this.host.credentialLedger.lease(owned.manager, () => {
        const renewal = this.renewRetainedReviewer(owned).finally(() => {
          if (owned.reviewerRenewal === renewal) delete owned.reviewerRenewal
        })
        owned.reviewerRenewal = renewal
        return renewal
      })],
      onFailure: error => owned.controller.abort(error),
    })
  }

  private async renewRetainedReviewer(owned: OwnedNativeSession): Promise<void> {
    const credential = this.host.credentialLedger.get(owned.manager)
    if (!credential || this.host.ownedSessions.get(owned.execution.id) !== owned)
      throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The retained process lease changed.', 409)
    await this.host.credentialLedger.renew(owned.manager, owned.execution.id, {
      signal: owned.controller.signal,
      check: async () => {
        owned.controller.signal.throwIfAborted()
        if (this.host.ownedSessions.get(owned.execution.id) !== owned)
          throw new DomainError('REVIEWER_CREDENTIAL_LOST', 'The retained process no longer owns its lease.', 409)
        await this.host.validateContinuation?.(owned.execution.id, owned.controller.signal)
      },
    })
    if (!owned.reviewOwner && owned.session) {
      try {
        const retained = await this.host.retainRunOwner(owned.execution, () => {})
        try {
          this.host.adoptRunOwner(retained.owner)
          await owned.manager.observeBoundary(owned.session, owned.controller.signal)
          delete owned.retainedObservationError
        } finally { await retained.release() }
      } catch (error) { owned.retainedObservationError = error }
    }
  }

  recoverRetainedReviewer(execution: HarnessExecution, owner: RunOwnership,
    parentSignal?: AbortSignal, job?: ReviewJob): Promise<boolean> {
    const existing = this.reviewerRecoveries.get(execution.id)
    if (existing) return existing
    const recovery = this.recoverRetainedReviewerOwned(execution, owner, parentSignal, job)
      .finally(() => {
        if (this.reviewerRecoveries.get(execution.id) === recovery) this.reviewerRecoveries.delete(execution.id)
      })
    this.reviewerRecoveries.set(execution.id, recovery)
    return recovery
  }

  private async recoverRetainedReviewerOwned(execution: HarnessExecution, owner: RunOwnership,
    parentSignal?: AbortSignal, job?: ReviewJob): Promise<boolean> {
    const existing = this.host.ownedSessions.get(execution.id)
    if (existing) {
      if (existing.failed) throw new DomainError('REVIEWER_AUTHORITY_LOST',
        'The original remote reviewer recovery did not complete.', 409)
      if (!existing.reviewerRecoveryPending) return existing.manager.retainsReviewerSession
    }
    if (execution.state !== 'completed' || execution.result?.outcome !== 'succeeded' || !execution.nativeSessionId)
      return false
    const configuration = await this.host.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    if (!configuration || (configuration.productRole !== 'master' && configuration.productRole !== 'orchestrator')) return false
    const context = await this.host.managerContext(execution, configuration)
    if (context.acceptedPlacement?.hostRef.kind !== 'device') return false
    const native = await this.host.interactions.coordination.workflowSession(execution.id)
    if (!native?.finalized) return false
    owner.assertOwned()
    const run = await this.host.runs.get(execution.runId, owner)
    if (!run || !isRunInProgress(run.executionState) || !this.host.workflowClosures
      || !this.host.credentials?.recoverRemote) return false
    const retained = await owner.oneShotConnection().transaction(sql => readRecoverableRemoteReviewer(sql, execution))
    if (!retained) return false
    const request = await this.host.workflowRequest(execution, configuration, run, owner)
    const resolved = this.host.resolveManager({ ...context, workflowRequest: request }, owner)
    if (!existing) resolved.beginStart?.()
    const owned = this.host.lifecycle.ownSession(execution,
      { ...context, workflowRequest: request, purpose: 'reviewer' }, resolved.manager)
    owned.reviewerRecoveryPending = true
    owned.runOwner = owner
    const signal = AbortSignal.any([owned.controller.signal, ...(parentSignal ? [parentSignal] : [])])
    owned.closureRegistration = Promise.resolve(retained.generation)
    owned.closureGeneration = retained.generation
    owned.restartAttachment = { session: native.session, request }
    try {
      let lane = await this.host.interactions.coordination.getLane(native.session.harness, native.session.nativeSessionId)
      while (lane?.leaseExpiresAt && Date.parse(lane.leaseExpiresAt) > Date.now()) {
        owner.assertOwned()
        signal.throwIfAborted()
        await delay(Math.min(100, Date.parse(lane.leaseExpiresAt) - Date.now()), undefined, { signal })
        lane = await this.host.interactions.coordination.getLane(native.session.harness, native.session.nativeSessionId)
      }
      owner.assertOwned()
      signal.throwIfAborted()
      const current = await owner.oneShotConnection().transaction(sql => readRecoverableRemoteReviewer(sql, execution))
      if (!isDeepStrictEqual(current, retained)) throw new DomainError('REVIEWER_AUTHORITY_LOST',
        'The retained reviewer changed while its original writer lease expired.', 409)
      // Only the dispatcher supplies a claimed, heartbeating job. A saved lease can belong to the crashed Main.
      if (job) {
        if (!this.host.credentials.bindReviewerJob) throw new DomainError('REVIEWER_CREDENTIAL_LOST',
          'The original reviewer credential cannot bind its current job.', 409)
      }
      const identity = reviewPreflightIdentity(lane, `execution:${execution.id}`)
      if (retained.detached) {
        owned.closureRegistration = this.host.workflowClosures.begin(execution)
        owned.closureGeneration = await owned.closureRegistration
      }
      const session = await this.host.lifecycle.openingSession(owned, resolved.manager.attachSession(native.session,
        { request, ...identity }, signal))
      this.host.assertSessionIdentity(native.session, session)
      if (!resolved.manager.retainsReviewerSession) throw new DomainError('REVIEWER_AUTHORITY_LOST',
        'The original remote reviewer lifetime has already closed.', 409)
      const access = await resolved.manager.originalApplicationAccess(session, signal)
      const expected = { generation: owned.closureGeneration, principalId: retained.principalId, session: retained.session }
      const assertRetainedReviewer = async (sql: SqlQuery) => {
        const current = await readRetainedRemoteReviewer(sql, execution)
        if (!isDeepStrictEqual(current, expected)) throw new DomainError('REVIEWER_AUTHORITY_LOST',
          'The retained reviewer no longer matches its original terminal and process lease.', 409)
      }
      await owner.oneShotConnection().transaction(async sql => {
        await assertRetainedReviewer(sql)
        if (!job) await retainRemoteReviewerCredential(sql, execution, expected)
      })
      if (job) {
        await this.host.credentials.bindReviewerJob!(execution.id, { principalId: retained.principalId }, job)
      }
      const credential = await this.host.credentials.recoverRemote(execution.id, access, job)
      if (credential.principalId !== retained.principalId) throw new DomainError('REVIEWER_AUTHORITY_LOST',
        'The original reviewer credential changed during recovery.', 409)
      this.host.credentialLedger.set(owned.manager, credential)
      await owner.oneShotConnection().transaction(assertRetainedReviewer)
      resolved.markResident?.()
      this.maintainRetainedReviewer(owned)
      delete owned.reviewerRecoveryPending
      return true
    } catch (error) {
      if (isRestartCancellation(error, signal)) throw error
      const attemptCanceled = parentSignal?.aborted && !owned.controller.signal.aborted
      if (attemptCanceled || isTransientRefreshFailure(error) || isLeaseLost(error)
        || error instanceof DomainError && error.code === 'SESSION_LANE_BUSY') throw error
      resolved.markFailed?.()
      owned.failed = true
      throw error
    }
  }

  async finishIdleReviewers(runId: string, owner: RunOwnership, signal: AbortSignal): Promise<void> {
    if (owner.runId !== runId) throw new DomainError('RUN_OWNERSHIP_LOST', 'The reviewer Run owner changed.', 409)
    const run = await this.host.runs.get(runId, owner)
    owner.assertOwned()
    signal.throwIfAborted()
    for (const owned of this.host.ownedSessions.values()) {
      if (owned.execution.runId !== runId || owned.context.purpose !== 'reviewer'
        || !owned.manager.retainsReviewerSession) continue
      // Remote closure needs the cleanup intent committed with Run completion.
      if (owned.context.acceptedPlacement?.hostRef.kind === 'device' && run?.executionState !== 'completed') continue
      const session = owned.session
      if (!session) throw new DomainError('REPEAT_CLEANUP_PENDING', 'The reviewer session is unavailable.', 409)
      const check = () => {
        owner.assertOwned()
        signal.throwIfAborted()
        if (this.host.ownedSessions.get(owned.execution.id) !== owned || owned.reviewFinishing) {
          throw new DomainError('REPEAT_CLEANUP_PENDING', 'The reviewer lifetime is still settling.', 409)
        }
      }
      check()
      const savedLane = await this.host.interactions.coordination.getLane(session.harness, session.nativeSessionId)
      check()
      if (!savedLane) throw new DomainError('REPEAT_CLEANUP_PENDING', 'The reviewer writer lane is unavailable.', 409)
      const correlationId = savedLane.correlationId ?? `execution:${owned.execution.id}`
      try {
        await owned.manager.withLane(session, correlationId,
          signal, async (manager, lane) => {
            check()
            await lane.guard.check()
            if (await this.host.interactions.coordination.hasUnsettledReview(owned.execution.id)) {
              throw new DomainError('REPEAT_CLEANUP_PENDING', 'The reviewer still has unfinished reviews.', 409)
            }
            await owned.manager.requireIdle(manager, session, correlationId, lane, signal)
            check()
            await this.host.lifecycle.closeRepeatLifetime(owned, check)
            lane.observedStatus = 'idle'
            await lane.guard.check()
          })
      } catch (error) {
        if (error instanceof DomainError && error.code === 'SESSION_LANE_BUSY') {
          throw new DomainError('REPEAT_CLEANUP_PENDING', 'The reviewer writer is still active.', 409, undefined, { cause: error })
        }
        throw error
      }
    }
  }

  /** Bind only an existing execution of the designated reviewer in this Run. Never spawn a substitute. */
  async enqueueReview(interaction: DurableInteraction): Promise<void> {
    if (interaction.status !== 'pending' || interaction.approval.handler !== 'orchestrator') return
    const agentId = interaction.approval.designatedOrchestratorAgentId
    if (!agentId || agentId === interaction.requestingAgentId) return
    const connection = await this.host.interactions.assertOrchestratorConnection(interaction)
    const existingJob = await this.host.interactions.coordination.findReviewJob(interaction.id, agentId)
    if (existingJob) {
      await this.host.interactions.coordination.assertReviewConnection(existingJob)
      return
    }
    if (!this.host.repeatReviewerBindings || !connection) throw new DomainError('REPEAT_REVIEW_IDENTITY_CONFLICT',
      'The occurrence-qualified reviewer binding is unavailable.', 409)
    const executions = [(await this.host.repeatReviewerBindings.select(interaction, connection.orchestratorNodeId)).execution]
    const candidates = executions
      .filter((execution) => execution.agentId === agentId && execution.workflowNodeId === connection?.orchestratorNodeId
        && execution.nativeSessionId && execution.workingDirectory && execution.runtimeDirectory)
    // No guessing between attempts/sessions. The pending interaction remains the recovery source.
    if (candidates.length !== 1) return
    const execution = candidates[0]!
    const configuration = await this.host.runs.getExecutionConfiguration(execution.agentConfigurationVersionId, execution)
    if (!configuration || (configuration.productRole !== 'master' && configuration.productRole !== 'orchestrator')) return
    const native = await this.host.interactions.coordination.workflowSession(execution.id)
    if (!native?.finalized || execution.state !== 'completed') return
    await this.host.reviewers.enqueue(interaction, agentId, {
      ...native.session,
    }, { executionId: execution.id, workingDirectory: execution.workingDirectory! })
  }

  /** Pending interactions repair a crash between creation and enqueue, including sessions bound later. */
  async reconcileReviews(onError: (error: unknown) => void): Promise<void> {
    let afterId: string | undefined
    do {
      const page = await this.host.interactions.list({ handler: 'orchestrator', status: 'pending', limit: 100,
        ...(afterId ? { afterId } : {}) })
      for (const interaction of page) await this.enqueueReview(interaction).catch(onError)
      afterId = page.length === 100 ? page.at(-1)!.id : undefined
    } while (afterId)
    await this.host.reviewers.reconcile(onError)
  }
}

import { setTimeout as delay } from 'node:timers/promises'
import { isDeepStrictEqual } from 'node:util'
import { NativeSessionReferenceSchema, type DurableInteraction, type ExecutionResult, type HarnessExecution } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { nativePersistenceRedactor } from './nativePersistence.js'
import { attemptCleanup, cleanupTimeoutMs, withCleanupDeadline } from './cleanup.js'
import { deviceRequestTimeoutMs } from '../devices/deviceRequestRetry.js'
import { readExecutionPlacement } from '../placement/persistence.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { RunOwnership } from '../runs/ownership.js'
import { readRemoteWorkflowContinuation, recoverWorkflowNativeClosure } from './workflowClosure.js'
import { repeatTickIndex } from '../runs/repeatResolution.js'
import { reviewPreflightIdentity } from './reviewPolicy.js'
import { assertSameRepeatExecution } from './repeatObservation.js'
import { isCredentialAuthorityLost, restorableApproval } from './executionPredicates.js'
import type { ExecutionSessionHost, OwnedNativeSession } from './execution.js'

/** Stop, cold-restart cleanup and engine-restart detachment of native sessions. */
export class ExecutionCancellation {
  private readonly cancellations = new Map<string, Promise<void>>()
  private restartClosure: Promise<void> | undefined
  constructor(private readonly host: ExecutionSessionHost) {}

  private async awaitWorkflowStartup(owned: OwnedNativeSession, owner: RunOwnership): Promise<boolean> {
    const starting = owned.starting
    // An opening session can publish its identity and first batch while restart waits.
    if (!starting || !owned.opening && !owned.session) return true
    const manager = owned.manager
    const generation = owned.generation + (owned.opening ? 1 : 0)
    const closureGeneration = owned.closureGeneration
    const failures: Error[] = []
    await attemptCleanup(failures, 'Await original workflow startup', async () => { await starting })
    owner.assertOwned()
    owned.startupPending = failures.length > 0
    if (failures.length) {
      componentLogger('engine').warn({ executionId: owned.execution.id },
        'Workflow startup wait timed out; checking the published session for restart preservation')
    }
    return this.host.ownedSessions.get(owned.execution.id) === owned && owned.runOwner === owner
      && owned.starting === starting && owned.manager === manager && owned.generation === generation
      && owned.closureGeneration === closureGeneration
      && !owned.openingFailed && !owned.failed && !owned.cleanup
  }

  async preserveActiveForRestart(owner: RunOwnership): Promise<boolean> {
    const snapshot = await this.host.runs.getRepeatSnapshot(owner.runId, owner)
    if (snapshot.stopRequested || snapshot.cleanupPending || snapshot.run.executionState === 'completed') return false
    const active: OwnedNativeSession[] = []
    const executionsToPreserve: HarnessExecution[] = []
    // An attempt that cannot survive the restart is abandoned alone; its node retries after
    // restart. An attempt waiting for an approval keeps the Run-level restart cleanup.
    let unpreservedWait = false, retried = 0
    const abandon = async (execution: HarnessExecution, resident?: OwnedNativeSession) => {
      if (execution.state === 'waiting') { unpreservedWait = true; return }
      retried++
      // A startup still in flight cannot be closed here without waiting on it: restart
      // closure disposes its manager and recovery after restart abandons the attempt.
      if (resident && (resident.opening || resident.preparing || resident.startupPending || !resident.session)) return
      await this.restartInterrupted(owner, execution,
        'The application restarted before this attempt produced an accepted result.')
    }
    for await (const executions of this.host.runs.executionPages(owner.runId, owner)) {
      for (const execution of executions) {
        const owned = this.host.ownedSessions.get(execution.id)
        if (owned && !await this.awaitWorkflowStartup(owned, owner)) {
          // Startup is still settling: restart closure disposes its manager and recovery
          // after restart abandons the attempt, so its node retries it.
          if (execution.state === 'waiting') unpreservedWait = true
          else retried++
          continue
        }
        owner.assertOwned()
        const manager = owned?.manager
        const generation = owned?.generation
        const closureGeneration = owned?.closureGeneration
        const current = await this.host.runs.getExecution(execution.id, owner)
        owner.assertOwned()
        if (!current || this.host.ownedSessions.get(execution.id) !== owned
          || owned?.manager !== manager || owned?.generation !== generation
          || owned?.closureGeneration !== closureGeneration) return false
        assertSameRepeatExecution(execution, current)
        if (current.state === 'completed' || current.state === 'queued') continue
        if (repeatTickIndex(current.input) !== undefined
          && !await this.preserveIntervalCheckForRestart(owner, current, owned)) continue
        if (!current.nativeSessionId) { await abandon(current, owned); continue }
        if (!owned) {
          const session = ['running', 'waiting'].includes(current.state) && (await this.host.detachedWorkflowSession(owner, current)
            ?? (await readRemoteWorkflowContinuation(owner, current))?.session)
          if (session) executionsToPreserve.push(current)
          else await abandon(current)
          continue
        }
        if (!owned.session || owned.openingFailed || owned.failed || owned.cleanup
          || owned.session.nativeSessionId !== current.nativeSessionId) { await abandon(current, owned); continue }
        assertSameRepeatExecution(owned.execution, current)
        const recovery = owned.restartRecovery
        const credential = this.host.credentialLedger.get(owned.manager)
        if (recovery?.principalId && credential && credential.principalId !== recovery.principalId) { await abandon(current, owned); continue }
        const restoring = recovery?.owner === owner && !!(owned.preparing || owned.opening)
          && recovery.attachmentGeneration === owned.closureGeneration
          && isDeepStrictEqual(recovery.session, owned.session)
        if (!restoring && (!owned.closureGeneration || owned.opening
          || !owned.manager.canDetachForRestart?.(owned.session))) { await abandon(current, owned); continue }
        active.push(owned)
        executionsToPreserve.push(current)
      }
    }
    if (unpreservedWait || !executionsToPreserve.length && !retried) return false
    const ready = await this.host.runs.getRepeatSnapshot(owner.runId, owner)
    if (ready.stopRequested || ready.cleanupPending || ready.run.executionState === 'completed') return false
    owner.assertOwned()
    const waiting = new Set<string>()
    for (const execution of executionsToPreserve) {
      try { await this.host.budgets.beginWait(execution.id) }
      catch (error) {
        // An execution that finished after it was listed has nothing left to preserve.
        if (!(error instanceof DomainError && error.code === 'EXECUTION_NOT_WAITABLE')
          || (await this.host.runs.getExecution(execution.id, owner))?.state !== 'completed') throw error
        continue
      }
      waiting.add(execution.id)
    }
    owner.assertOwned()
    if (!waiting.size && !retried) return false
    for (const owned of active.filter(item => waiting.has(item.execution.id))) {
      try { await this.renewForRestart(owned, owner) }
      catch (error) {
        if (isCredentialAuthorityLost(error)) return false
        throw error
      }
    }
    owner.assertOwned()
    return true
  }

  private async preserveIntervalCheckForRestart(owner: RunOwnership, execution: HarnessExecution,
    owned: OwnedNativeSession | undefined): Promise<boolean> {
    if (execution.nativeSessionId && !owned) {
      const session = await this.host.detachedWorkflowSession(owner, execution)
        ?? (await readRemoteWorkflowContinuation(owner, execution))?.session
      if (session) return true
    } else if (execution.nativeSessionId && owned?.session && !owned.openingFailed && !owned.failed
      && !owned.cleanup && owned.manager.canDetachForRestart?.(owned.session)) {
      return true
    }
    await this.failIntervalCheck(owner, execution)
    return false
  }

  private async renewForRestart(owned: OwnedNativeSession, owner?: RunOwnership): Promise<void> {
    if (!this.host.credentials?.renew || !this.host.credentialLedger.has(owned.manager)) return
    await this.host.credentialLedger.renew(owned.manager, owned.execution.id, {
      force: true,
      check: async () => {
        owner?.assertOwned()
        if (this.host.ownedSessions.get(owned.execution.id) !== owned || owned.failed || owned.cleanup)
          throw new DomainError('NATIVE_CREDENTIAL_RECOVERY_REQUIRED', 'The native process no longer owns its lease.', 409)
        if (this.host.validateContinuation?.forRestart) await this.host.validateContinuation.forRestart(owned.execution.id)
        else await this.host.validateContinuation?.(owned.execution.id)
        owner?.assertOwned()
      },
    })
  }

  /** Production calls this AFTER stopping/draining producers and BEFORE raw
   * manager disposal. Waiting Workers and retained reviewers are not Stop: their
   * checkpoints, budgets, credentials and business records must survive restart.
   * Every sibling is attempted; failed/uncertain closure keeps shutdown failed. */
  closeForRestart(): Promise<void> {
    this.host.closing = true
    if (this.restartClosure) return this.restartClosure
    const sessions = [...this.host.ownedSessions.values()]
    const reason = new DomainError('ENGINE_RESTART', 'The native lifetime is detaching for application restart.', 409)
    const drainingReviews = this.host.reviewers.shutdown()
    // A captured finalizer may already be running outside the dispatch guard.
    // Keep its lifetime valid until the dispatcher has joined it.
    for (const owned of sessions) {
      if (!owned.reviewFinalizer) owned.controller.abort(reason)
    }
    const task = (async () => {
      const reviewResults = await Promise.allSettled([drainingReviews])
      for (const owned of sessions) owned.controller.abort(reason)
      const closeSession = async (owned: OwnedNativeSession, owner?: RunOwnership) => {
        const safe = nativePersistenceRedactor(this.host.credentialLedger.secrets(owned.manager))
        const failures: Error[] = []
        await attemptCleanup(failures, `${owned.execution.id}: close for restart`, async signal => {
          if (this.host.ownedSessions.get(owned.execution.id) !== owned) return
          if (this.host.closedExecutions.has(owned.execution.id)) return
          // Local engine ownership can finish before its native session detaches.
          const snapshot = await this.host.runs.getRepeatSnapshot(owned.execution.runId, owner)
          // A failed or closing attempt has no lifetime to preserve; renewing it for detachment fails its lease check.
          if (snapshot.stopRequested || snapshot.cleanupPending || owned.failed || owned.cleanup) {
            const cleanup = await this.host.lifecycle.cleanupSession(owned)
            if (cleanup.length) throw new AggregateError(cleanup, 'Interrupted native cleanup remains unconfirmed.')
            return
          }
          if (owned.consultation) {
            if (owned.opening) await owned.opening
            if (!owned.session) { await owned.manager.dispose(signal); return }
            const credential = owned.consultation.credential
            if (credential && this.host.credentials?.renewConsultation) {
              credential.expiresAt = await this.host.credentials.renewConsultation(owned.consultation.binding, credential, signal)
            }
            // Detachment preserves this exact consultation's correlation and
            // credential; the completed source execution remains closed.
            await owned.manager.closeForRestart(owned.session, signal)
            return
          }
          if (owned.restartAttachment && !owned.failed
            && (!owned.session || owned.openingFailed || owned.generation === 0)) {
            const { session, request } = owned.restartAttachment
            const remote = owned.context.acceptedPlacement?.hostRef.kind === 'device'
            const variables = remote ? undefined : await owned.manager.originalEnvironment?.(session)
            if (remote || variables) {
              const lane = await this.host.interactions.coordination.getLane(session.harness, session.nativeSessionId)
              const identity = reviewPreflightIdentity(lane, `execution:${owned.execution.id}`)
              const attached = await this.host.lifecycle.openingSession(owned, owned.manager.attachSession(session, {
                request, ...identity,
                ...(variables ? { environment: { agentId: owned.execution.agentId, variables } } : {}),
              }))
              this.host.assertSessionIdentity(session, attached)
            }
          }
          // Creation can finish before the session binding commits. Dispose the
          // captured manager when startup settles without a persisted binding.
          if (!owned.session || owned.openingFailed || owned.generation === 0 || !owned.execution.nativeSessionId) {
            await owned.manager.dispose(signal)
            return
          }
          if (snapshot.run.executionState !== 'completed') {
            try { await this.renewForRestart(owned, owner) }
            catch (error) {
              if (!isCredentialAuthorityLost(error)) throw error
              await this.host.runs.requestCleanup(owned.execution.runId, owner)
              const cleanup = await this.host.lifecycle.cleanupSession(owned)
              if (cleanup.length) {
                throw new AggregateError(cleanup, 'Interrupted native cleanup remains unconfirmed.', { cause: error })
              }
              return
            }
          }
          await this.host.lifecycle.closeWorkflowSessionOwned(owned, { restart: true, signal })
        }, owned.context.acceptedPlacement?.hostRef.kind === 'device' ? { timeoutMs: deviceRequestTimeoutMs } : {})
        return failures.map((error) => safe.error(error) as Error)
      }
      const runs = new Map<string, OwnedNativeSession[]>()
      for (const owned of sessions) {
        const siblings = runs.get(owned.execution.runId) ?? []
        siblings.push(owned)
        runs.set(owned.execution.runId, siblings)
      }
      const results = await Promise.allSettled([...runs.values()].map(async siblings => {
        // Aborting renewal stops its timer, but an observation can still be
        // acquiring or releasing the Run lock. Join it before selecting an owner.
        await withCleanupDeadline(async () => Promise.all(siblings.map(async owned => {
          // Startup errors belong to their caller; its manager and cleanup must still drain.
          await Promise.allSettled([
            this.host.reviewerSessions.recovery(owned.execution.id), owned.starting, owned.preparing, owned.opening, owned.consultation?.task,
            owned.stopWaitingRenewal?.(), owned.stopReviewerRenewal?.(), owned.reviewerRenewal,
          ])
          await owned.cleanup
        })), siblings.some(owned => owned.context.acceptedPlacement?.hostRef.kind === 'device')
          ? deviceRequestTimeoutMs : cleanupTimeoutMs)
        const resident = siblings.filter(owned => this.host.ownedSessions.get(owned.execution.id) === owned
          && !this.host.closedExecutions.has(owned.execution.id))
        const ownerSession = resident.find(owned => owned.context.acceptedPlacement?.hostRef.kind === 'device'
          || this.host.credentials?.renew && this.host.credentialLedger.has(owned.manager))
        const retained = ownerSession && await withCleanupDeadline(async signal => {
          for (;;) {
            signal.throwIfAborted()
            try {
              return await this.host.retainRunOwner(ownerSession.execution, () => {
                for (const owned of siblings) owned.controller.abort()
              })
            } catch (error) {
              if (!(error instanceof DomainError) || error.code !== 'SESSION_LANE_BUSY') throw error
              await delay(25, undefined, { signal })
            }
          }
        }, ownerSession.context.acceptedPlacement?.hostRef.kind === 'device' ? deviceRequestTimeoutMs : cleanupTimeoutMs)
        try {
          // Sibling closes share one Run lock until every close or cleanup commits.
          if (retained) this.host.adoptRunOwner(retained.owner)
          return (await Promise.all(resident.map(owned => closeSession(owned, retained?.owner)))).flat()
        } finally { if (retained) await retained.release() }
      }))
      const safe = nativePersistenceRedactor(sessions.flatMap(owned =>
        this.host.credentialLedger.secrets(owned.manager)))
      const failures = results.flatMap(result => result.status === 'fulfilled'
        ? result.value : [safe.error(result.reason) as Error])
      for (const result of reviewResults) {
        if (result.status === 'rejected') failures.push(safe.error(result.reason) as Error)
      }
      if (failures.length) throw new AggregateError(failures, 'Native restart closure was incomplete.', { cause: failures[0] })
    })()
    this.restartClosure = task
    // A failed receipt/close is not cached success. The same captured manager
    // may retry; no new generation or substitute session is admitted here.
    void task.catch(() => { if (this.restartClosure === task) this.restartClosure = undefined })
    return task
  }

  /** Recover restart-detached turns and checkpoint-bound approvals, answered or not.
   * Other cold nonterminal lifetimes require physical cleanup before settlement. */
  async requestColdRunCleanup(owner: RunOwnership, approvals: readonly DurableInteraction[] = [],
    signal?: AbortSignal): Promise<boolean> {
    owner.assertOwned()
    this.host.adoptRunOwner(owner)
    await this.host.consultations.recoverWorkflowConsultations(owner)
    for await (const executions of this.host.runs.executionPages(owner.runId, owner)) {
      for (const execution of executions) {
        if (repeatTickIndex(execution.input) !== undefined && execution.state !== 'completed') {
          const failed = await owner.oneShotConnection().query(
            'select 1 from approval_execution_state where execution_id=$1 and failure_result is not null',
            [execution.id])
          if (failed.rowCount) {
            await this.failIntervalCheck(owner, execution)
            continue
          }
        }
        const resident = this.host.ownedSessions.get(execution.id)
        if (resident) {
          if (resident.controller.signal.aborted && execution.state !== 'completed') {
            if (execution.state !== 'waiting') {
              await this.restartInterrupted(owner, execution)
              continue
            }
            await this.host.runs.requestCleanup(owner.runId, owner)
            return true
          }
          if (resident.pendingApprovalRestoration) {
            const pending = approvals.filter(item => item.executionId === execution.id)
            if (execution.state === 'waiting' && pending.length && pending.every(restorableApproval)
              && await this.host.restorePendingWorkflowApprovals(owner, execution, pending, signal)) continue
            await this.host.runs.requestCleanup(owner.runId, owner)
            return true
          }
          continue
        }
        if (execution.state === 'queued' && !execution.nativeSessionId && !execution.startedAt) continue
        if (execution.state === 'running' && execution.nativeSessionId
          && (await this.host.detachedWorkflowSession(owner, execution)
            ?? (await readRemoteWorkflowContinuation(owner, execution))?.session)) continue
        const pending = approvals.filter((item) => item.executionId === execution.id)
        if (execution.state === 'waiting' && pending.length && pending.every(restorableApproval)) {
          if (await this.host.restorePendingWorkflowApprovals(owner, execution, pending, signal)) continue
        }
        if (execution.state === 'waiting' && !pending.length && execution.nativeSessionId
          && (await this.host.detachedWorkflowSession(owner, execution)
            ?? (await readRemoteWorkflowContinuation(owner, execution))?.session)) continue
        if (execution.state === 'completed') continue
        // Restart lost this attempt's native lifetime: close it alone and let its node retry.
        // An attempt waiting for an approval keeps the Run-level recovery path.
        if (execution.state !== 'waiting') {
          await this.restartInterrupted(owner, execution)
          continue
        }
        await this.host.runs.requestCleanup(owner.runId, owner)
        owner.assertOwned()
        return true
      }
    }
    // Close interrupted attempts before recovering the completed reviewer.
    for await (const executions of this.host.runs.executionPages(owner.runId, owner)) {
      for (const execution of executions) {
        if (this.host.ownedSessions.has(execution.id) || execution.state !== 'completed') continue
        try {
          if (await this.host.reviewerSessions.recoverRetainedReviewer(execution, owner, signal)) continue
        } catch (error) {
          if (!(error instanceof DomainError) || error.code !== 'REVIEWER_AUTHORITY_LOST') throw error
          await this.host.runs.requestCleanup(owner.runId, owner, { outcome: 'failed',
            error: { code: error.code, message: error.message, retryable: false } })
          owner.assertOwned()
          return true
        }
        if (await this.host.recoverOutputSettlement(execution, owner, signal)) continue
        if (execution.nativeSessionId && !await this.host.workflowClosures?.read(execution)) {
          // A finalized workflow has already closed its original lifetime and
          // may have handed this session to a reviewer. Missing closure now
          // belongs to that later lifetime, not to the original terminal gap.
          // This owner-bound read selects cleanup only; it is NOT closure
          // evidence. The negative pass still rechecks generation/session
          // and requires positive physical proof under the committed fence.
          const native = (await owner.oneShotConnection().query<{ reference: unknown; finalized: boolean }>(
            'select reference,workflow_finalized_at is not null as finalized from execution_native_sessions where execution_id=$1 for share',
            [execution.id])).rows[0]
          owner.assertOwned()
          if (native?.finalized === true) {
            if (NativeSessionReferenceSchema.parse(native.reference).nativeSessionId !== execution.nativeSessionId) {
              throw new DomainError('NATIVE_SESSION_IDENTITY_MISMATCH', 'Cleanup changed the captured native session.', 409)
            }
            await this.host.runs.requestCleanup(owner.runId, owner)
            owner.assertOwned()
            return true
          }
          const failures: Error[] = []
          await attemptCleanup(failures, `${execution.id}: recover terminal native lifetime`, (signal) =>
            recoverWorkflowNativeClosure(owner, execution, this.host.recoverNativeProcesses, signal, { purpose: 'terminal' }),
          { timeoutMs: await this.recoveryCleanupTimeout(owner, execution) })
          owner.assertOwned()
          if (failures.length) throw new AggregateError(failures, 'Terminal native closure remains unconfirmed.')
        }
        // Includes a failed original terminal: do not poison technical retry
        // by setting cleanupPending before the repository evaluates its slot.
      }
    }
    await this.host.recoverExecutionControls(owner)
    return false
  }

  /** Close one failed check before its successor can be admitted. */
  async failIntervalCheck(owner: RunOwnership, execution: HarnessExecution,
    failure: ExecutionResult = { outcome: 'failed', error: {
      code: 'EXECUTION_INTERRUPTED',
      message: 'The native attempt was closed without an accepted result.',
      retryable: false,
    } }): Promise<void> {
    if (repeatTickIndex(execution.input) === undefined) throw new DomainError(
      'TICK_NODE_CONFLICT', 'Only an interval check may settle independently of graph work.', 409)
    await this.abandonAttempt(owner, execution, failure)
  }

  /** An interval check fails until its next tick; any other attempt is retried by its node. */
  restartInterrupted(owner: RunOwnership, execution: HarnessExecution,
    message = 'The attempt lost its native session before it produced an accepted result.'): Promise<void> {
    if (repeatTickIndex(execution.input) !== undefined) return this.failIntervalCheck(owner, execution)
    return this.abandonAttempt(owner, execution, { outcome: 'failed',
      error: { code: 'EXECUTION_INTERRUPTED', message, retryable: true } })
  }

  private async recoveryCleanupTimeout(owner: RunOwnership, execution: HarnessExecution): Promise<number> {
    const resident = this.host.ownedSessions.get(execution.id)
    const placement = resident ? resident.context.acceptedPlacement
      : await readExecutionPlacement(owner.oneShotConnection(), execution.id)
    owner.assertOwned()
    return placement?.hostRef.kind === 'device' ? deviceRequestTimeoutMs : cleanupTimeoutMs
  }

  /** Close one attempt for its own recorded cause, without fencing the Run or
   * touching sibling credentials, budgets or sessions. Closure is best effort:
   * an unconfirmed close leaves only this attempt's settlement pending. A
   * retryable cause lets the node start a fresh attempt with the same input. */
  async abandonAttempt(owner: RunOwnership, execution: HarnessExecution, failure: ExecutionResult): Promise<void> {
    owner.assertOwned()
    const store = await this.host.runs.repeat(owner)
    const stored = (await store.readExecution(execution.id)).execution
    assertSameRepeatExecution(execution, stored)
    if (stored.state === 'completed') return
    componentLogger('harness').warn({ executionId: stored.id, runId: owner.runId, attempt: stored.attempt,
      code: failure.outcome === 'failed' ? failure.error?.code : undefined,
      reason: failure.outcome === 'failed' ? failure.error?.message : undefined }, 'Abandoning one native attempt')
    await this.host.budgets.ensure(stored.id, owner.runId, this.host.activeTimeoutMs)
    await this.host.runs.recordExecutionFailure(owner, stored.id, failure)
    const timeoutMs = await this.recoveryCleanupTimeout(owner, stored)
    const resident = this.host.ownedSessions.get(stored.id)
    if (resident) {
      // A session save can commit even when its acknowledgement never reaches the caller.
      resident.execution = stored
      resident.failed = true
      resident.controller.abort(new DomainError('EXECUTION_ABANDONED', 'This attempt was abandoned for a fresh attempt.', 409))
      const errors = await this.host.lifecycle.cleanupSession(resident)
      if (errors.length) {
        await withCleanupDeadline(signal => recoverWorkflowNativeClosure(
          owner, stored, this.host.recoverNativeProcesses, signal, {
            purpose: 'failed_attempt', ...(resident.closureGeneration ? { generation: resident.closureGeneration } : {}),
          }), timeoutMs)
        const remaining = await this.host.lifecycle.cleanupSession(resident)
        if (remaining.length) throw new AggregateError(remaining, 'Abandoned attempt native closure remains unconfirmed.')
      }
    } else {
      await withCleanupDeadline(signal => recoverWorkflowNativeClosure(
        owner, stored, this.host.recoverNativeProcesses, signal, { purpose: 'failed_attempt' }), timeoutMs)
      await this.host.credentials?.revokeForExecution(stored.id)
    }
    owner.assertOwned()
    await this.host.budgets.stop(stored.id)
    await store.settleNegativeExecution(stored.id, false)
  }

  /** Stop first fences all new work in the database. This pass only cancels
   * ORIGINAL resident managers and revokes execution resources under that fence.
   * The owner-only cold pass also recovers failed resident transports using
   * positive closure receipts for their captured lifetime generation.
   * Positive repository proof, not this method's return value, settles a Run. */
  async cancelRun(runId: string, owner?: RunOwnership): Promise<void> {
    owner?.assertOwned()
    if (owner && owner.runId !== runId) throw new DomainError('GRAPH_SCOPE_MISMATCH', 'The Run owner does not match cleanup.', 409)
    const snapshot = await this.host.runs.getRepeatSnapshot(runId, owner)
    if (!snapshot.stopRequested && !snapshot.cleanupPending && snapshot.run.executionState !== 'completed') {
      throw new DomainError('GRAPH_STOP_CONFLICT', 'Native cancellation requires the committed Stop or cleanup fence.', 409)
    }
    this.host.stoppingRuns.add(runId)
    this.host.pendingCleanupRuns.add(runId)
    if (owner) {
      if (owner.runId !== runId) throw new DomainError('RUN_OWNERSHIP_LOST', 'The cancellation owner belongs to another Run.', 409)
      this.host.adoptRunOwner(owner)
      await this.host.consultations.recoverStoppedConsultations(owner)
    }
    let task = this.cancellations.get(runId)
    if (!task) {
      task = (async () => {
        const failures: Error[] = []
        const owned = [...this.host.ownedSessions.values()].filter((item) => item.execution.runId === runId)
        for (const item of owned) item.controller.abort()
        const closures = owned.map((item) => this.host.lifecycle.cleanupSession(item))
        await attemptCleanup(failures, 'cancel unresolved interactions', () => this.host.interactions.cancelPendingForRun(runId).then(() => undefined))
        // Every sibling is attempted, even when one native close fails. Budget
        // and credential revocation are negative actions, not closure evidence.
        for await (const executions of this.host.runs.executionPages(runId)) {
          for (const execution of executions) {
            await attemptCleanup(failures, `${execution.id}: revoke credentials`, () =>
              this.host.credentials ? this.host.credentials.revokeForExecution(execution.id).then(() => undefined) : Promise.resolve())
            await attemptCleanup(failures, `${execution.id}: stop budget`, () => this.host.budgets.stop(execution.id))
          }
        }
        for (const result of await Promise.allSettled(closures)) {
          if (result.status === 'fulfilled') failures.push(...result.value)
          else failures.push(new Error('Captured native cleanup failed.', { cause: result.reason }))
        }
        if (failures.length) throw new AggregateError(failures, 'Captured native cleanup remains incomplete.')
      })().finally(() => { this.cancellations.delete(runId) })
      this.cancellations.set(runId, task)
    }
    let retryResidentCleanup = false
    try {
      await task
    } catch (error) {
      if (!owner || !(error instanceof AggregateError)) throw error
      // Retry every failed operation only after owner-fenced physical recovery.
      retryResidentCleanup = true
    }
    if (owner) {
      owner.assertOwned()
      const store = await this.host.runs.repeat(owner)
      const failures: Error[] = []
      for await (const executions of this.host.runs.executionPages(runId, owner)) {
        for (const execution of executions) {
          const resident = this.host.ownedSessions.get(execution.id)
          if (resident && !retryResidentCleanup) continue
          await attemptCleanup(failures, `${execution.id}: recover original native lifetime`, async (signal) => {
            if (resident) {
              assertSameRepeatExecution(resident.execution, execution)
              if (resident.opening || resident.cleanup || !resident.closureGeneration) throw new DomainError(
                'REPEAT_CLEANUP_PENDING', 'The original native operation is still completing cleanup.', 409)
            }
            await recoverWorkflowNativeClosure(owner, execution, this.host.recoverNativeProcesses, signal,
              resident ? { generation: resident.closureGeneration! } : {})
          }, { timeoutMs: deviceRequestTimeoutMs })
        }
      }
      if (failures.length) throw new AggregateError(failures, 'Cold native closure remains unconfirmed.')
      if (retryResidentCleanup) await this.cancelRun(runId)
      // Original closures and revocations above precede review retirement. The
      // attempt settlement gate below requires those review receipts, not vice versa.
      await this.host.interactions.coordination.finishStoppedReviews(runId, Boolean(this.host.credentials))
      owner.assertOwned()
      for await (const executions of this.host.runs.executionPages(runId, owner)) {
        for (const execution of executions) {
          // Seals a positively reserved/prepared attempt or verifies its exact
          // native close/disposal. An entered unknown lifetime stays pending.
          await store.settleNegativeExecution(execution.id, snapshot.stopRequested)
          await this.host.collaboration?.release(owner, (await store.readExecution(execution.id)).execution,
            snapshot.stopRequested ? 'stop' : 'terminal', snapshot.version)
        }
      }
      owner.assertOwned()
    }
  }
}

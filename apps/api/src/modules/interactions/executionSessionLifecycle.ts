import type { HarnessExecution, NativeSessionReference } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { nativePersistenceRedactor } from './nativePersistence.js'
import type { SingleWriterSessionManager } from './sessionWriter.js'
import { attemptCleanup } from './cleanup.js'
import { deviceRequestTimeoutMs } from '../devices/deviceRequestRetry.js'
import type { NativeManagerResolutionContext } from './runtimePorts.js'
import type { ExecutionSessionHost, OwnedNativeSession } from './execution.js'

/** Native session lifecycle: ownership, opening, exact close receipts and cleanup of one execution. */
export class ExecutionSessionLifecycle {
  constructor(private readonly host: ExecutionSessionHost) {}

  ownSession(execution: HarnessExecution, context: NativeManagerResolutionContext, manager: SingleWriterSessionManager): OwnedNativeSession {
    if (this.host.closing) throw new Error('Native sessions are shutting down.')
    if (this.host.stoppingRuns.has(execution.runId)) throw new Error('The Run is stopping; native work cannot be restarted.')
    let owned = this.host.ownedSessions.get(execution.id)
    if (!owned) {
      this.host.closedExecutions.delete(execution.id)
      this.host.closedWorkflowSessions.delete(execution.id)
      owned = { execution, context, manager, controller: new AbortController(), generation: 0 }
      this.host.ownedSessions.set(execution.id, owned)
    }
    return owned
  }

  openingSession(owned: OwnedNativeSession, operation: Promise<NativeSessionReference>): Promise<NativeSessionReference> {
    const opening = operation.then(
      (session) => {
        owned.session = session
        owned.generation += 1
        // A late create/attach completion invalidates earlier closure evidence.
        if (!owned.consultation) {
          this.host.closedExecutions.delete(owned.execution.id)
          this.host.closedWorkflowSessions.delete(owned.execution.id)
        }
        delete owned.openingFailed
        return session
      },
      (error: unknown) => { owned.openingFailed = true; throw error },
    ).finally(() => { if (owned.opening === opening) delete owned.opening })
    owned.opening = opening
    return opening
  }

  private rememberClosedWorkflowSession(execution: HarnessExecution, session: NativeSessionReference): void {
    this.host.closedWorkflowSessions.set(execution.id, {
      execution: { id: execution.id, runId: execution.runId, workflowNodeId: execution.workflowNodeId,
        agentId: execution.agentId, agentConfigurationVersionId: execution.agentConfigurationVersionId,
        attempt: execution.attempt, nativeSessionId: session.nativeSessionId,
        ...(execution.workingDirectory ? { workingDirectory: execution.workingDirectory } : {}),
        ...(execution.runtimeDirectory ? { runtimeDirectory: execution.runtimeDirectory } : {}) },
      session: { ...session },
    })
  }

  /** Persist only the exact manager's confirmed close, for Stop AND ordinary
   * runtime disposal. This does not cancel the Run, stop its budget, retire its
   * approval, revoke execution authority or finalize its workflow lifetime. */
  async closeWorkflowSession(owned: OwnedNativeSession,
    options: { restart?: boolean; signal?: AbortSignal } = {}): Promise<void> {
    if (owned.context.acceptedPlacement?.hostRef.kind !== 'device')
      return this.closeWorkflowSessionOwned(owned, options)
    let owner = owned.reviewOwner ?? owned.runOwner
    try { owner?.assertOwned() }
    catch (error) {
      if (!(error instanceof DomainError) || error.code !== 'RUN_OWNERSHIP_LOST') throw error
      await owner?.release()
      owner = undefined
    }
    const acquired = !owner
    owner ??= await this.host.runs.acquireOwnership(owned.execution.runId, () => owned.controller.abort())
    if (!owner) throw new DomainError('SESSION_LANE_BUSY', 'The Run is still draining its native owner.', 409)
    this.host.adoptRunOwner(owner)
    const releaseOwner = owner.retain(() => owned.controller.abort())
    try { await this.closeWorkflowSessionOwned(owned, options) }
    finally {
      await releaseOwner()
      if (acquired) await owner.release()
    }
  }

  async closeWorkflowSessionOwned(owned: OwnedNativeSession,
    options: { restart?: boolean; signal?: AbortSignal }): Promise<void> {
    const { restart, signal } = options
    signal?.throwIfAborted()
    const session = owned.session
    if (!session) throw new DomainError('NATIVE_WORKFLOW_CLOSURE_CONFLICT',
      'The native connection is not ready for an exact close receipt.', 409)
    const generation = owned.generation
    if (restart) await owned.manager.closeForRestart(session, signal)
    else await owned.manager.close(session, signal)
    // Persist the same positive close that formerly survived only in RAM.
    // Registration precedes native preflight/spawn; no cold resolver or
    // terminal business state can create this receipt.
    const assertCurrent = () => {
      signal?.throwIfAborted()
      if (this.host.ownedSessions.get(owned.execution.id) !== owned
        || owned.generation !== generation || owned.opening) {
        throw new DomainError('NATIVE_WORKFLOW_CLOSURE_CONFLICT', 'The native manager lifetime changed during close.', 409)
      }
    }
    assertCurrent()
    if (this.host.workflowClosures && owned.closureRegistration
      && (!owned.closureGeneration || owned.generation === 0 || owned.openingFailed)) {
      throw new DomainError('NATIVE_WORKFLOW_CLOSURE_CONFLICT', 'No confirmed native connection owns this close receipt.', 409)
    }
    if (!this.host.workflowClosures || !owned.closureGeneration) throw new DomainError(
      'NATIVE_WORKFLOW_CLOSURE_CONFLICT', 'The exact original native lifetime has no durable reservation.', 409)
    if (restart) {
      // Detachment makes a later exact attach eligible, not Stop, a result or a
      // cleanup success. It can never be upgraded into a terminal close receipt.
      await this.host.workflowClosures.recordDetached(owned.execution, session, owned.closureGeneration, assertCurrent)
      assertCurrent()
      this.host.closedExecutions.delete(owned.execution.id)
      this.host.closedWorkflowSessions.delete(owned.execution.id)
      return
    }
    const durable = await this.host.workflowClosures.record(owned.execution, session, owned.closureGeneration, assertCurrent)
    assertCurrent()
    this.host.closedExecutions.add(owned.execution.id)
    this.host.closedWorkflowSessions.set(owned.execution.id, durable)
  }

  cleanupSession(owned: OwnedNativeSession, cancel = true): Promise<Error[]> {
    if (owned.consultation) return this.host.consultations.cleanupConsultation(owned)
    if (cancel) owned.controller.abort()
    if (owned.cleanup) return owned.cleanup
    const safe = nativePersistenceRedactor(this.host.credentialLedger.secrets(owned.manager))
    const task = (async () => {
      const failures: Error[] = []
      const attempt = <T>(label: string, operation: (signal: AbortSignal) => Promise<T>) =>
        attemptCleanup(failures, `${owned.execution.id}: ${label}`, operation,
          owned.context.acceptedPlacement?.hostRef.kind === 'device' ? { timeoutMs: deviceRequestTimeoutMs } : {})
      // Create/attach can be in flight when Stop arrives. Never invent an identity
      // or replay a turn to obtain a session that can be canceled.
      if (owned.launchReservation) await attempt('await native launch reservation', async () => { await owned.launchReservation })
      if (owned.opening) await attempt('await native session', async () => { await owned.opening })
      // A persisted session reference is not evidence that THIS manager ever
      // attached it. A failed cold attach cannot close an invented local session.
      let closed = false
      if (owned.session && owned.execution.nativeSessionId) {
        const session = owned.session
        const proof = await attempt('read exact durable closure', () => this.host.workflowClosures!.read(owned.execution))
        if (proof?.durableGeneration === owned.closureGeneration) closed = true
        if (!closed) {
          if (cancel) await attempt('cancel native session', (signal) => owned.manager.cancel(session, signal))
          closed = await attempt('close native session', async signal => {
            await this.closeWorkflowSession(owned, { signal })
            return true
          }) === true
        }
      } else {
        // Positive disposal, not an empty map, no-session row or a terminal enum.
        // The captured manager rejects future setup and drains all its creates.
        const manager = owned.manager
        const generation = owned.generation
        const observedSession = owned.session
        const disposed = await attempt('dispose original unbound native manager', async signal => {
          await manager.dispose(signal)
          return true
        }) === true
        if (disposed && !owned.opening && owned.session === observedSession && owned.generation === generation) {
          const check = () => {
            if (this.host.ownedSessions.get(owned.execution.id) !== owned || owned.manager !== manager
              || owned.generation !== generation || owned.opening || owned.session !== observedSession
              || owned.execution.nativeSessionId) throw new DomainError('NATIVE_LIFETIME_CHANGED',
              'The unbound native manager changed during disposal.', 409)
          }
          const registration = owned.closureRegistration && await attempt('read native lifetime reservation', async () => {
            try {
              return await owned.closureRegistration!
            } catch (error) {
              check()
              const neverEntered = generation === 0 && !observedSession && !owned.closureGeneration
                && !owned.openingFailed
              // Stop can reject reservation before entry; this manager has already confirmed disposal.
              if (neverEntered && error instanceof DomainError && error.code === 'NATIVE_WORKFLOW_CLOSURE_CONFLICT') {
                return undefined
              }
              throw error
            }
          })
          if (registration && this.host.workflowClosures) {
            const proof = await attempt('record positive unbound disposal', () => this.host.workflowClosures!.recordUnbound(owned.execution, registration, check))
            closed = proof?.durableGeneration === registration
          } else {
            // No lifetime was entered. The repository must additionally seal its
            // positive reserved/prepared entry before any terminal can commit.
            check(); closed = true
          }
        }
      }
      if (closed) this.host.closedExecutions.add(owned.execution.id)
      const revoked = await attempt('revoke execution credential', async () => {
        await this.host.credentials?.revokeForExecution(owned.execution.id)
        return true
      })
      if (closed && revoked && !owned.opening) {
        const released = await attempt('release native manager', async () => { this.host.credentialLedger.delete(owned.manager); this.host.managers.release?.(owned.context, this.host.rawManagers.get(owned.manager) ?? owned.manager, owned.failed ? 'failed' : 'released'); return true })
        if (released && this.host.ownedSessions.get(owned.execution.id) === owned) this.host.ownedSessions.delete(owned.execution.id)
      }
      if ((!closed || owned.opening) && !failures.length) failures.push(new Error(`${owned.execution.id}: native session closure is unconfirmed.`))
      return failures.map((error) => safe.error(error) as Error)
    })().finally(() => { delete owned.cleanup })
    owned.cleanup = task
    return task
  }

  /** Close only the captured, registered native lifetime. Unlike Stop recovery,
   * this path has no resolver, capability query, orphan-process fallback or new
   * credential. Failure leaves the owner resident and the durable barrier closed. */
  async closeRepeatLifetime(owned: OwnedNativeSession, assertCurrent: () => void,
    finishRecoveredCredentials?: () => Promise<void>): Promise<void> {
    const session = owned.session
    const generation = owned.generation
    const registration = owned.closureGeneration
    const credential = this.host.credentialLedger.get(owned.manager)
    const check = () => {
      assertCurrent()
      if (this.host.ownedSessions.get(owned.execution.id) !== owned || owned.generation !== generation
        || owned.opening || owned.openingFailed || !session || !registration || !this.host.workflowClosures
        || owned.closureGeneration !== registration || owned.session !== session
        || this.host.credentials && !credential
          && !(owned.terminalRecoveredWithoutCredential && finishRecoveredCredentials)
        || credential && (this.host.credentialLedger.get(owned.manager)?.principalId !== credential.principalId
          || this.host.credentialLedger.get(owned.manager)?.environment !== credential.environment)) {
        throw new DomainError('REPEAT_CLEANUP_PENDING', 'The exact native lifetime cannot yet be closed.', 409)
      }
    }
    check()
    if (owned.cleanup) throw new DomainError('REPEAT_CLEANUP_PENDING', 'Native cleanup is already in progress.', 409)
    // Keep the actual operation registered even when a caller's outer deadline
    // expires. A timeout is not closure and cannot start a competing finalizer.
    const close = async (signal: AbortSignal): Promise<Error[]> => {
      check()
      const proof = await this.host.workflowClosures!.read(owned.execution)
      check()
      if (!proof || proof.durableGeneration !== registration) await this.closeWorkflowSession(owned, { signal })
      check()
      if (credential) await this.host.credentials?.revoke({ principalId: credential.principalId })
      else if (owned.terminalRecoveredWithoutCredential && finishRecoveredCredentials) {
        await finishRecoveredCredentials()
      }
      check()
      this.host.credentialLedger.delete(owned.manager)
      await owned.stopWaitingRenewal?.()
      await owned.stopReviewerRenewal?.()
      await owned.releaseReviewOwner?.()
      delete owned.reviewOwner
      delete owned.releaseReviewOwner
      this.host.managers.release?.(owned.context, this.host.rawManagers.get(owned.manager) ?? owned.manager,
        owned.failed ? 'failed' : 'released')
      if (this.host.ownedSessions.get(owned.execution.id) === owned) this.host.ownedSessions.delete(owned.execution.id)
      return []
    }
    const failures: Error[] = []
    const bounded: Promise<Error[]> = (async () => {
      await attemptCleanup(failures, `${owned.execution.id}: close exact repeat lifetime`, signal => {
        const task = close(signal)
        // Keep an unfinished close registered until its operation acknowledges cancellation.
        void task.finally(() => { if (owned.cleanup === bounded) delete owned.cleanup }).catch(() => {
          // ignore: the bounded cleanup promise reports the same failure to its caller.
        })
        return task
      }, owned.context.acceptedPlacement?.hostRef.kind === 'device' ? { timeoutMs: deviceRequestTimeoutMs } : {})
      const safe = nativePersistenceRedactor(Object.values(credential?.environment.variables ?? {}))
      return failures.map((error) => safe.error(error) as Error)
    })()
    owned.cleanup = bounded
    const errors = await bounded
    if (errors.length) throw new AggregateError(errors, 'Exact native lifetime cleanup is incomplete.')
  }
}

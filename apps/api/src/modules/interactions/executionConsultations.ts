import { setTimeout as delay } from 'node:timers/promises'
import { type HarnessExecution, type HarnessExecutionRequest, type CoordinatorConsultationBinding, canonicalJson } from '@foreman-code/contracts'
import { remainingCredentialLifetime } from '../access/credentialLifetime.js'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE, WORKER_CREDENTIAL_RENEWAL_WINDOW_MS, type IssuedWorkerCredential } from '../access/workerCredentials.js'
import { DomainError } from '../errors.js'
import type { WorkflowChatLockedTarget, WorkflowChatTarget, WorkflowControlCommand } from '../collaboration/workflowControlTypes.js'
import { admittedWorkflowChatPrompt } from './workflowChatInput.js'
import { readWorkflowControlCommandLocked } from '../collaboration/workflowControlRecords.js'
import { observeWorkflowConsultation } from './workflowConsultationObserver.js'
import { readCoordinatorConsultationLocked, failCoordinatorConsultationPreparationLocked, settleCoordinatorConsultationLocked } from '../collaboration/workflowConsultations.js'
import type { ConsultationTransaction } from '../collaboration/consultationBrowser.js'
import { attemptCleanup, cleanupTimeoutMs, withCleanupDeadline } from './cleanup.js'
import { deviceRequestTimeoutMs } from '../devices/deviceRequestRetry.js'
import { componentLogger } from '../diagnostics/logger.js'
import type { RunOwnership } from '../runs/ownership.js'
import { workflowExecutionRequest } from '../runs/workflowExecutionRequest.js'
import { isRestartCancellation } from './executionPredicates.js'
import type { ExecutionSessionHost, OwnedNativeSession } from './executionSessionHost.js'

/** Retained coordinator consultations: start, credential upkeep, release and Stop cleanup. */
export class ExecutionConsultations {
  private readonly consultationStarts = new Map<string, Promise<void>>()
  constructor(private readonly host: ExecutionSessionHost) {}

  private consultationTransaction(owner: RunOwnership,
    target: Extract<WorkflowChatTarget, { kind: 'workflow_coordinator' }>): ConsultationTransaction {
    return async work => (await this.host.runs.repeat(owner)).workflowChatTransaction(target, undefined,
      () => owner.assertOwned(), work)
  }

  dispatchWorkflowConsultation(target: WorkflowChatTarget, command: WorkflowControlCommand,
    owner: RunOwnership, source: HarnessExecution): Promise<void> {
    if (target.kind !== 'workflow_coordinator' || !command.consultation) return Promise.resolve()
    const existing = this.consultationStarts.get(command.consultation.consultationId)
    if (existing) return existing
    const task = this.startWorkflowConsultation(target, command, owner, source)
      .finally(() => { this.consultationStarts.delete(command.consultation!.consultationId) })
    this.consultationStarts.set(command.consultation.consultationId, task)
    return task
  }

  private async startWorkflowConsultation(target: Extract<WorkflowChatTarget, { kind: 'workflow_coordinator' }>,
    command: WorkflowControlCommand, owner: RunOwnership, source: HarnessExecution): Promise<void> {
    const transaction = this.consultationTransaction(owner, target)
    const active = await transaction(context => readCoordinatorConsultationLocked(context.sql, source.runId, target.waitingActivationId))
    if (!active || active.commandId !== command.id || !command.request || !command.consultation
      || canonicalJson(active.binding) !== canonicalJson(command.consultation)
      || ['completed','failed','canceled'].includes(active.state)) return
    let owned = this.host.ownedSessions.get(source.id)
    if (owned?.consultation?.task) return
    if (owned && (owned.cleanup || owned.opening || owned.failed || owned.controller.signal.aborted
      || !owned.consultation && owned.context.purpose !== 'reviewer')) {
      throw new DomainError('COORDINATOR_NATIVE_SOURCE_PENDING', 'The original coordinator session is still settling.', 409)
    }
    if (await this.host.interactions.coordination.hasUnsettledReview(source.id)) throw new DomainError(
      'COORDINATOR_NATIVE_SOURCE_PENDING', 'The original coordinator is completing an admitted review.', 409)
    const configuration = await this.host.runs.getExecutionConfiguration(source.agentConfigurationVersionId, source)
    const run = await this.host.runs.get(source.runId)
    const reference = await this.host.interactions.coordination.workflowSession(source.id)
    if (!configuration || !run || !reference?.finalized || reference.session.nativeSessionId !== active.binding.nativeSessionId
      || source.state !== 'completed') throw new DomainError('COORDINATOR_NATIVE_SOURCE_PENDING',
      'The consultation requires the exact completed delegation session.', 409)
    const request = await this.host.workflowRequest(source, configuration, run, owner)
    const context = { ...await this.host.managerContext(source, configuration, 'consultation'),
      consultation: active.binding, correlationId: `consultation:${active.binding.consultationId}`, workflowRequest: request }
    const resolved = owned ? undefined : this.host.resolveManager(context, owner)
    if (!owned) {
      owned = { execution: source, context, manager: resolved!.manager, controller: new AbortController(), generation: 0 }
      // A consultation does not reopen or delete the source execution's closure.
      this.host.ownedSessions.set(source.id, owned)
    }
    const current = owned
    if (!current.consultation) current.consultation = { binding: active.binding, commandId: command.id, target,
      ...(current.context.purpose === 'reviewer' ? { previous: { context: current.context,
        ...(this.host.credentialLedger.get(current.manager) ? { credential: this.host.credentialLedger.get(current.manager)! } : {}) } } : {}) }
    if (canonicalJson(current.consultation.binding) !== canonicalJson(active.binding)) throw new DomainError(
      'COORDINATOR_NATIVE_SOURCE_PENDING', 'Another consultation still owns the retained coordinator.', 409)
    current.runOwner = owner
    const consultation = current.consultation
    const release = owner.retain(() => current.controller.abort())
    const check = () => {
      owner.assertOwned()
      if (this.host.ownedSessions.get(source.id) !== current || current.consultation !== consultation
        || current.controller.signal.aborted || current.failed || current.opening) throw new DomainError(
        'COORDINATOR_NATIVE_OWNER_CHANGED', 'The consultation lost its captured native lifetime.', 409)
    }
    try {
      await current.stopReviewerRenewal?.()
      delete current.stopReviewerRenewal
      if (resolved?.processState === 'needs_start') {
        await this.host.reserveNativeLaunch?.(source.id, this.host.rawManagers.get(current.manager) ?? current.manager, active.binding)
        resolved.beginStart?.()
      }
      if (consultation.previous) consultation.accessRebindAttempted = true
      if (!consultation.credential) consultation.credential = await this.prepareConsultationCredential(
        current, active.binding, !!active.nativeTarget)
      this.host.credentialLedger.set(current.manager, consultation.credential)
      await this.host.collaboration?.prepareConsultation(owner, source, active.binding, transaction)
      const browserPrompt = await this.host.collaboration?.readConsultationPrompt(active.binding, transaction)
      const start = { kind: 'workflow-consultation' as const, consultation: active.binding, request,
        correlationId: `consultation:${active.binding.consultationId}`,
        ...(active.nativeTurnId ? { nativeTurnId: active.nativeTurnId } : {}),
        environment: consultation.credential.environment, instructionsDelivered: true as const }
      if (current.session) {
        if (!active.nativeTarget) await current.manager.rebindApplicationAccess!(current.session, start, current.controller.signal)
      } else {
        const attached = await this.host.lifecycle.openingSession(current, current.manager.attachSession(reference.session, start, current.controller.signal))
        this.host.assertSessionIdentity(reference.session, attached)
        resolved?.markResident?.()
      }
      check()
      current.activeSessionMode = command.request.sessionMode ?? 'regular'
      const snapshot = await this.host.runs.getRepeatSnapshot(source.runId, owner)
      const capacity = this.host.executionCapacity(source.runId, snapshot.version.definition.executionPolicy!.maxParallelism)
      const stopRenewal = this.maintainConsultationCredential(current)
      const sessionMode = current.activeSessionMode, credential = consultation.credential
      const task = capacity.run(current.controller.signal, () => observeWorkflowConsultation({ binding: active.binding, commandId: command.id, agentId: source.agentId,
        session: current.session!, manager: current.manager, transaction, signal: current.controller.signal,
        prompt: [admittedWorkflowChatPrompt(command), browserPrompt].filter(Boolean).join('\n\n'), sessionMode,
        captured: active.nativeTarget, secrets: Object.values(credential.environment.variables), assertCurrent: check,
        acknowledge: async (lease, providerId) => {
          await this.host.interactions.coordination.bindLaneTurn(lease.fence, lease.correlationId)
          await this.host.interactions.coordination.acknowledgeLaneTurn(lease.fence, lease.correlationId, providerId)
        }, onSubmitted: () => {}, beforeSettlement: async (raw, lease) => {
          await stopRenewal()
          await this.host.collaboration?.releaseConsultation(active.binding, transaction, 'terminal')
          await this.host.credentials!.revoke(consultation.credential!)
          await lease.guard.check()
          if (consultation.previous?.credential) await raw.rebindApplicationAccess?.(current.session!, {
            request, environment: consultation.previous.credential.environment, instructionsDelivered: true,
            correlationId: `execution:${source.id}` }, lease.guard.signal)
          else if (raw.closeForResume) await raw.closeForResume(current.session!)
          else await raw.close(current.session!, lease.guard.signal)
        },
      })).then(async next => {
        this.releaseConsultationEntry(current)
        if (next) await this.dispatchPromotedConsultation(owner, source, target, next.commandId)
      }).catch(async error => {
        current.retainedObservationError = error
        if (!isRestartCancellation(error, current.controller.signal)) componentLogger('harness').warn(
          { consultationId: active.binding.consultationId, code: error instanceof DomainError ? error.code : 'NATIVE_OBSERVATION_FAILED' },
          'The original consultation remains pending native reconciliation.')
      }).finally(async () => {
        await stopRenewal(); delete consultation.task; await release()
      })
      consultation.task = task
    } catch (error) {
      try {
        const captured = await transaction(c => readCoordinatorConsultationLocked(c.sql, source.runId, target.waitingActivationId))
        if (captured?.binding.consultationId === active.binding.consultationId
          && !captured.nativeTarget && captured.state === 'admitted') {
          await this.releaseFailedConsultationPreparation(current, request, transaction)
          const next = await transaction(c => failCoordinatorConsultationPreparationLocked(c.sql, { binding: active.binding,
            errorCode: error instanceof DomainError ? error.code : 'CONSULTATION_PREPARATION_FAILED', now: new Date().toISOString() }))
          this.releaseConsultationEntry(current)
          if (next) await this.dispatchPromotedConsultation(owner, source, target, next.commandId)
        }
      } finally { await release() }
      throw error
    }
  }

  private async dispatchPromotedConsultation(owner: RunOwnership, source: HarnessExecution,
    target: Extract<WorkflowChatTarget, { kind: 'workflow_coordinator' }>, commandId: string): Promise<void> {
    const command = await this.consultationTransaction(owner, target)(context =>
      readWorkflowControlCommandLocked(context.sql, source.runId, commandId))
    if (command) await this.dispatchWorkflowConsultation(target, command, owner, source)
  }

  private async releaseFailedConsultationPreparation(owned: OwnedNativeSession, request: HarnessExecutionRequest,
    transaction: ConsultationTransaction): Promise<void> {
    const consultation = owned.consultation!
    await withCleanupDeadline(async signal => {
      if (owned.opening) await owned.opening
      if (consultation.previous) {
        if (consultation.accessRebindAttempted) {
          if (!owned.session || !consultation.previous.credential) throw new DomainError(
            'REVIEWER_CREDENTIAL_LOST', 'The original reviewer credential is required for restoration.', 409)
          await owned.manager.rebindApplicationAccess(owned.session, { request,
            environment: consultation.previous.credential.environment, instructionsDelivered: true,
            correlationId: `execution:${owned.execution.id}` }, signal)
        }
      } else {
        await owned.manager.dispose(signal)
      }
    }, owned.context.acceptedPlacement?.hostRef.kind === 'device' ? deviceRequestTimeoutMs : cleanupTimeoutMs)
    await this.host.collaboration?.releaseConsultation(consultation.binding, transaction, 'terminal')
    if (consultation.credential) await this.host.credentials!.revoke(consultation.credential)
  }

  private async prepareConsultationCredential(owned: OwnedNativeSession,
    binding: CoordinatorConsultationBinding, recovery: boolean): Promise<IssuedWorkerCredential> {
    if (!this.host.credentials) throw new DomainError('CONSULTATION_CREDENTIAL_UNAVAILABLE', 'Scoped consultation access is unavailable.', 409)
    const signal = owned.controller.signal
    if (!recovery) return (await this.host.credentials.prepare({ executionId: owned.execution.id,
      harness: owned.context.harness, workingDirectory: owned.context.workingDirectory,
      purpose: 'consultation', consultation: binding,
      ...(owned.session ? { session: owned.session } : {}),
      manager: this.host.rawManagers.get(owned.manager) ?? owned.manager, signal })).credential
    if (!this.host.credentials.restoreConsultation) throw new DomainError('CONSULTATION_CREDENTIAL_UNAVAILABLE',
      'The original consultation credential cannot be restored.', 409)
    const reference = await this.host.interactions.coordination.workflowSession(owned.execution.id)
    if (!reference) throw new DomainError('COORDINATOR_NATIVE_SOURCE_PENDING', 'The original consultation session is unavailable.', 409)
    let variables = await owned.manager.originalEnvironment?.(reference.session, signal)
    if (!variables && owned.context.acceptedPlacement?.hostRef.kind === 'device') {
      const access = await owned.manager.originalApplicationAccess(reference.session, signal)
      variables = { [APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]: access.token }
    }
    if (!variables) throw new DomainError('CONSULTATION_CREDENTIAL_UNAVAILABLE', 'The original native credential remains unknown.', 409)
    return this.host.credentials.restoreConsultation(binding, { agentId: owned.execution.agentId, variables })
  }

  private maintainConsultationCredential(owned: OwnedNativeSession): () => Promise<void> {
    const consultation = owned.consultation!, credential = consultation.credential!
    const stop = new AbortController()
    const signal = AbortSignal.any([stop.signal, owned.controller.signal])
    const task = (async () => {
      while (!signal.aborted) {
        await delay(Math.max(1000, remainingCredentialLifetime(credential) - WORKER_CREDENTIAL_RENEWAL_WINDOW_MS),
          undefined, { signal })
        if (!this.host.credentials?.renewConsultation) throw new DomainError('CONSULTATION_CREDENTIAL_UNAVAILABLE',
          'The consultation process credential cannot be renewed.', 409)
        credential.expiresAt = await this.host.credentials.renewConsultation(consultation.binding, credential, signal)
      }
    })().catch(error => {
      if (!signal.aborted) { owned.retainedObservationError = error; owned.controller.abort(error) }
    })
    return async () => { stop.abort(); await task }
  }

  private releaseConsultationEntry(owned: OwnedNativeSession, discard = false): void {
    const previous = discard ? undefined : owned.consultation?.previous
    if (previous) {
      owned.context = previous.context
      delete owned.consultation; delete owned.activeSessionMode
      if (previous.credential) this.host.credentialLedger.set(owned.manager, previous.credential)
      else this.host.credentialLedger.delete(owned.manager)
      this.host.reviewerSessions.maintainRetainedReviewer(owned)
    } else {
      this.host.credentialLedger.delete(owned.manager)
      this.host.managers.release?.(owned.context, this.host.rawManagers.get(owned.manager) ?? owned.manager)
      if (this.host.ownedSessions.get(owned.execution.id) === owned) this.host.ownedSessions.delete(owned.execution.id)
    }
  }

  /** Run Stop closes the captured consultation, separately from its completed
   * delegation. A cancel acknowledgement never releases this mailbox. */
  cleanupConsultation(owned: OwnedNativeSession): Promise<Error[]> {
    owned.controller.abort()
    if (owned.cleanup) return owned.cleanup
    const consultation = owned.consultation!
    const task = (async () => {
      const failures: Error[] = []
      const retained = await this.host.retainRunOwner(owned.execution, () => {})
      const transaction = this.consultationTransaction(retained.owner, consultation.target)
      try {
        await attemptCleanup(failures, `${consultation.binding.consultationId}: close exact consultation`, async signal => {
          await consultation.task
          if (owned.opening) await owned.opening
          const session = owned.session, generation = owned.generation
          const check = () => {
            retained.owner.assertOwned(); signal.throwIfAborted()
            if (this.host.ownedSessions.get(owned.execution.id) !== owned || owned.consultation !== consultation
              || owned.session !== session || owned.generation !== generation || owned.opening) throw new DomainError(
              'COORDINATOR_NATIVE_OWNER_CHANGED', 'The exact consultation changed during cleanup.', 409)
          }
          check()
          const record = await transaction(async context => (await context.sql.query<{
            native_target: WorkflowChatLockedTarget['native'] | null; native_turn_id: string | null; state: string
          }>('select native_target,native_turn_id,state from run_coordinator_consultations where id=$1 and run_id=$2 for update',
          [consultation.binding.consultationId, consultation.binding.runId])).rows[0])
          if (!record) throw new DomainError('COORDINATOR_BINDING_CONFLICT', 'The consultation cleanup source is unavailable.', 409)
          if (session) {
            await owned.manager.cancel(session, signal, record.native_turn_id ?? record.native_target?.inputMessageId)
            check()
            if (consultation.previous && owned.closureGeneration) await this.host.lifecycle.closeWorkflowSession(owned, { signal })
            else await owned.manager.close(session, signal)
          } else {
            await owned.manager.dispose(signal)
          }
          check()
          await this.host.collaboration?.releaseConsultation(consultation.binding, transaction, 'stop')
          if (consultation.credential) await this.host.credentials?.revoke(consultation.credential)
          if (record.native_target && !['completed','failed','canceled'].includes(record.state)) {
            await transaction(context => settleCoordinatorConsultationLocked(context.sql, {
              binding: consultation.binding, outcome: 'canceled', now: new Date().toISOString(),
              nativeEvidence: { nativeSessionId: consultation.binding.nativeSessionId,
                ownerRequestId: record.native_target!.ownerRequestId,
                ...(record.native_turn_id ? { nativeTurnId: record.native_turn_id } : {}),
                ...(record.native_target!.inputMessageId ? { inputMessageId: record.native_target!.inputMessageId } : {}),
                observedAt: new Date().toISOString(), source: 'confirmed_closure',
                payload: { nativeSessionId: session?.nativeSessionId ?? null, lifetimeGeneration: generation,
                  closedBy: 'captured_coordinator_manager' } },
            }))
          }
          this.releaseConsultationEntry(owned, true)
        }, owned.context.acceptedPlacement?.hostRef.kind === 'device' ? { timeoutMs: deviceRequestTimeoutMs } : {})
      } finally { await retained.release() }
      return failures
    })().finally(() => { delete owned.cleanup })
    owned.cleanup = task
    return task
  }

  async recoverWorkflowConsultations(owner: RunOwnership): Promise<void> {
    if (!this.host.workflowControls) return
    const rows = (await owner.oneShotConnection().query<{ command_id: string; target: WorkflowChatTarget }>(
      `select c.command_id,q.target from run_coordinator_consultations c
        join run_coordinator_mailboxes m on m.run_id=c.run_id and m.active_consultation_id=c.id
        join run_chat_commands q on q.id=c.command_id and q.run_id=c.run_id
        where c.run_id=$1 and c.state in ('admitted','active','unknown','settling')
          and m.state='consultation' order by c.created_at,c.id`, [owner.runId])).rows
    for (const row of rows) {
      owner.assertOwned()
      await this.host.workflowControls.dispatch(row.target, row.command_id)
    }
  }

  /** Stop recovery attaches only the originally captured consultation/session.
   * It issues no credential and can neither offer a turn nor create a session. */
  async recoverStoppedConsultations(owner: RunOwnership): Promise<void> {
    const rows = (await owner.oneShotConnection().query<{ command_id: string; binding: CoordinatorConsultationBinding;
      target: Extract<WorkflowChatTarget, { kind: 'workflow_coordinator' }>; source_id: string;
      native_turn_id: string | null }>(`select c.command_id,c.binding,q.target,m.source_execution->>'executionId' as source_id,c.native_turn_id
      from run_coordinator_consultations c join run_coordinator_mailboxes m
        on m.run_id=c.run_id and m.waiting_activation_id=c.waiting_activation_id
      join run_chat_commands q on q.id=c.command_id and q.run_id=c.run_id
      where c.run_id=$1 and (c.state in ('active','unknown','settling')
        or c.browser_input is not null and c.browser_state is distinct from 'released') order by c.created_at,c.id`, [owner.runId])).rows
    for (const row of rows) {
      owner.assertOwned()
      let owned = this.host.ownedSessions.get(row.source_id)
      if (!owned?.consultation) {
        const source = await this.host.runs.getExecution(row.source_id, owner)
        const configuration = source && await this.host.runs.getExecutionConfiguration(source.agentConfigurationVersionId, source)
        const reference = source && await this.host.interactions.coordination.workflowSession(source.id)
        const snapshot = await this.host.runs.getRepeatSnapshot(owner.runId, owner)
        if (!source || !configuration || !reference || reference.session.nativeSessionId !== row.binding.nativeSessionId) {
          throw new DomainError('REPEAT_CLEANUP_PENDING', 'The original consultation cleanup source is unavailable.', 409)
        }
        const request = workflowExecutionRequest({ execution: source, version: snapshot.version,
          configuration, workspaceId: snapshot.run.workspaceId })
        const context = { ...await this.host.managerContext(source, configuration, 'consultation'), consultation: row.binding,
          correlationId: `consultation:${row.binding.consultationId}`, workflowRequest: request }
        const resolved = owned ? undefined : this.host.resolveManager(context, owner)
        owned ??= { execution: source, context, manager: resolved!.manager, controller: new AbortController(), generation: 0 }
        owned.consultation = { binding: row.binding, commandId: row.command_id, target: row.target,
          ...(owned.context.purpose === 'reviewer' ? { previous: { context: owned.context } } : {}) }
        owned.runOwner = owner
        this.host.ownedSessions.set(source.id, owned)
        if (!owned.session) {
          resolved?.beginStart?.()
          const attached = await this.host.lifecycle.openingSession(owned, owned.manager.attachSession(reference.session, {
            kind: 'workflow-consultation', consultation: row.binding, request, observationOnly: true,
            correlationId: `consultation:${row.binding.consultationId}`,
            ...(row.native_turn_id ? { nativeTurnId: row.native_turn_id } : {}), instructionsDelivered: true,
          }))
          this.host.assertSessionIdentity(reference.session, attached); resolved?.markResident?.()
        }
      }
      const errors = await this.cleanupConsultation(owned)
      if (errors.length) throw new AggregateError(errors, 'The original consultation still needs positive cleanup.')
    }
  }
}

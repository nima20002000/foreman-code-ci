import { supportsExpectedTurnSteer } from '../harnesses/capabilities.js'
import { DomainError } from '../errors.js'
import type { WorkflowChatTarget, WorkflowChatOwnerPort } from '../collaboration/workflowControlTypes.js'
import { createWorkflowChatOwner, type WorkflowChatNativeCapture } from './workflowChatOwner.js'
import type { RunOwnership } from '../runs/ownership.js'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import type { ExecutionSessionHost, OwnedNativeSession } from './executionSessionHost.js'

/** Run chat controls capture the current native owner and reconcile its durable commands. */
export class ExecutionWorkflowControls {
  constructor(private readonly host: ExecutionSessionHost) {}

  /** Public controls reuse this coordinator's current Run/native ownership.
   * Readback only projects the original observer's durable source. */
  workflowChatOwner(sql: SqlQuery,
    validateAdmission: WorkflowChatOwnerPort['validateAdmission']) {
    return this.host.workflowControls = createWorkflowChatOwner({ sql, runs: this.host.runs, validateAdmission,
      withOwner: async (target, work) => {
        const id = target.kind === 'workflow_execution' ? target.execution.executionId
          : (await sql.query<{ parent_execution_id: string }>(`select parent_execution_id from run_hierarchy_groups
            where run_id=$1 and parent_activation_id=$2 and parent_node_id=$3`,
          [target.runId, target.waitingActivationId, target.agent.workflowNodeId])).rows[0]?.parent_execution_id
        const source = id && await this.host.runs.getExecution(id)
        if (!source) throw new DomainError('CHAT_TARGET_NOT_FOUND', 'The exact Run-owned chat source is unavailable.', 404)
        const retained = await this.host.retainRunOwner(source, () => {})
        try { return await work(retained.owner, source) }
        finally { await retained.release() }
      },
      capture: (target, source) => this.captureWorkflowChatNative(target, this.host.ownedSessions.get(source.id)),
      captureForRead: target => this.captureWorkflowChatNative(target, target.kind === 'workflow_execution'
        ? this.host.ownedSessions.get(target.execution.executionId)
        : [...this.host.ownedSessions.values()].find(owned => owned.consultation?.binding.runId === target.runId
          && owned.consultation.binding.waitingActivationId === target.waitingActivationId)),
      dispatchConsultation: (target, command, owner, source) => this.host.consultations.dispatchWorkflowConsultation(target, command, owner, source),
    })
  }

  private captureWorkflowChatNative(target: WorkflowChatTarget,
    owned: OwnedNativeSession | undefined): WorkflowChatNativeCapture | undefined {
    if (!owned?.session || owned.failed || owned.cleanup || owned.opening || owned.controller.signal.aborted
      || !owned.activeSessionMode || this.host.closing || this.host.stoppingRuns.has(owned.execution.runId)) return undefined
    if (target.kind === 'workflow_execution' ? owned.execution.id !== target.execution.executionId || !!owned.consultation
      || owned.context.purpose === 'reviewer' : !owned.consultation
      || owned.consultation.binding.runId !== target.runId
      || owned.consultation.binding.waitingActivationId !== target.waitingActivationId) return undefined
    const session = owned.session, generation = owned.generation, mode = owned.activeSessionMode
    const lease = owned.manager.capturedLease(session), raw = this.host.rawManagers.get(owned.manager)
    if (!lease?.providerId || !raw || lease.guard.signal.aborted || lease.observedStatus === 'idle') return undefined
    const providerId = lease.providerId
    return { session, manager: owned.manager, lease,
      native: { nativeSessionId: session.nativeSessionId, ownerRequestId: lease.correlationId, providerId,
        ...(session.harness === 'codex' ? { nativeTurnId: providerId } : { inputMessageId: providerId }),
        sessionMode: mode, steer: supportsExpectedTurnSteer(session) && !!raw.steerTurn, interruptAndSend: true },
      assertCurrent: () => {
        if (this.host.ownedSessions.get(owned.execution.id) !== owned || owned.session !== session
          || owned.generation !== generation || owned.activeSessionMode !== mode || lease.providerId !== providerId
          || owned.failed || owned.cleanup || owned.controller.signal.aborted) throw new DomainError(
          'CHAT_NATIVE_TARGET_CHANGED', 'The captured original native owner changed.', 409)
        owned.manager.assertCapturedLease(session, lease)
      } }
  }

  /** The engine's existing reconciliation pass repairs admission/dispatch gaps.
   * Dispatch itself reconciles unknown offers and never submits them twice. */
  async reconcileWorkflowControls(onError: (error: unknown) => void): Promise<void> {
    const owners = new Map(this.host.sharedRunOwners)
    for (const owned of this.host.ownedSessions.values()) {
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
    if (!this.host.workflowControls) return
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
        await this.host.workflowControls.dispatch(row.target, row.id)
      }
      if (rows.length < 100) return
      after = rows.at(-1)!.sequence
    }
  }
}

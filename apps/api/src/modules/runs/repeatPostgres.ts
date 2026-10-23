import { IntervalCheckAcceptedInputSchema } from '@foreman-code/contracts/current'
import {
  SourceSchema, EntrySchema, readStoredRepeatOccurrence, readStoredRepeatExecution,
  readRepeatExecutionLocked, retainRepeatEffectReceipt, type StoredOccurrence, type StoredRepeatExecution,
} from './repeatExecutionRead.js'
import { readSystemPromptSetting } from '../settings/foundation.js'
import { withNativeGraphProjectionBatch } from '../run-graph/nativeIngestion.js'
import { readWorkflowSessionContinuation } from './sessionContinuation.js'
import { readWorkResultRepairAttempt } from './workResultRepair.js'
import { workflowDeliverableFailure } from './workflowDeliverable.js'
import { readWorkflowJobSourceLocked } from '../jobs/workflowSource.js'
import { z } from 'zod'
import { AgentConfigurationVersionSchema, ExecutionResultSchema, HarnessExecutionSchema, NativeSessionReferenceSchema,
  type ExecutionResult, type HarnessExecution, type HarnessExecutionContext, type ResultProtocol,
  type WorkflowControlContinuation } from '@foreman-code/contracts'
import {
  AcceptedCurrentNodeResultSchema, GraphDigestSchema, GraphExecutionIdentitySchema, GraphIdSchema, NodeResolutionSchema,
  RepeatDecisionMetadataV1Schema, RepeatDecisionV1Schema,
  RepeatOccurrenceIdentityV1Schema, RepeatOccurrenceV1Schema, WorkflowVersionCurrentSchema,
  canonicalGraphJson, parseRepeatExitResultV1,
  WorkActivationInputSchema, WorkReturnSchema,
  validateRepeatDecisionV1, validateRepeatSuccessorV1,
  type WorkflowRunCurrent, type WorkActivationInput, type RepeatDecisionMetadataV1,
  type RepeatDecisionV1, type RepeatOccurrenceV1, type WorkflowVersionCurrent,
} from '@foreman-code/contracts/current'

import { enterWorkflowNativeLocked, releaseWorkflowNativeEntryPermit, reserveWorkflowNativeEntryLocked, readWorkflowNativeEntryLocked,
  sealWorkflowPreparationFailureLocked,
  sealWorkflowNativeEntryLocked, workflowNativeReservation, type WorkflowNativeEntryPermit, type WorkflowNativeEntryRecord } from './workflowNativeEntry.js'
import {
  beforeGraphCommit
} from '../run-graph/connection.js'
import type { SqlQuery, SqlTransaction } from '../../infrastructure/transaction.js'
import type { RunOwnership } from './ownership.js'
import type { AcceptedRepeatRunSnapshot } from './repeatStartRead.js'
import { readWorkflowClosure, readUnboundWorkflowClosure } from '../interactions/workflowClosure.js'
import { assertApprovalTerminalSettlement } from '../interactions/current/resume.js'
import { settleRepeatNativeExecutionLocked } from '../interactions/repeatNativeSettlement.js'
import { finalizeRetainedRemoteReviewerLocked } from '../interactions/retainedRemoteReviewer.js'
import { visitRepeatNativeAttemptsLocked, type RepeatNativeAttemptSelection } from './repeatNativeAttempts.js'
import { compileExecutionTopology } from './topology.js'
import { assertWorkflowExecutionCapacityLocked } from './workflowExecutionBudget.js'
import { parseWorkResultLocked, readWorkResultContextLocked } from './workReturnValidation.js'
import { nextIntervalCheckAt, readIntervalCheckFacts } from './intervalChecks.js'
import { captureRepeatNativeEvidence, repeatLaunchClaim, repeatPossibleSubmissionLocked, requireRepeatNativeHooks,
  type RepeatLaunchPaths, type RepeatNativeBoundaryEvidence, type RepeatNativeChange,
  type RepeatNativeEvidence, type RepeatNativeLockedHooks } from './repeatNativeRepository.js'
import { inactiveRepeatResolution, prepareRepeatNativeUpdate, repeatTerminalResolution, type RepeatAcceptance, type RepeatAdmission } from './repeatNode.js'
import { admitWorkHandoffLocked, ensureWorkEntryLocked, readWorkActivationInputLocked, readWorkCallerReportLocked,
  recordUnresolvedWorkLocked, returnWorkHandoffLocked, resolveWaitingWorkJoinsLocked,
  type WorkRequestAdmission, type WorkReturnReceipt } from './workHandoffAdmission.js'
import { markWorkNoticeDeliveredLocked, markWorkNoticePendingLocked,
  markWorkNoticeUnknownLocked } from './workHandoffNotice.js'
import { assertWorkHandoffDeliveryLocked } from './workHandoffDelivery.js'
import { WorkExecutionFailure } from './workExecutionFailure.js'
import { admitHierarchyGroupLocked, type HierarchyGroupAdmission } from './hierarchyGroupAdmission.js'
import { markHierarchyContinuationStartedLocked } from './hierarchyGroupSettlement.js'
import { isHierarchyWorkflow } from './hierarchyResults.js'
import { declaresRepeatBlocks, usesWorkHandoffGraph } from './workflowRunMode.js'
import { assertHierarchyDirectionReleasedLocked, readHierarchyDirectionForSourceLocked,
  reserveHierarchyDirectionLocked } from './hierarchyDirection.js'
import { hierarchyCompletionLocked } from './hierarchyCompletion.js'
import type { WorkflowCollaborationHooks } from '../collaboration/workflowHooks.js'
import { workflowAdmissionLifecycleLocked, workflowLifecycleLocked,
  workflowNativeLifecycleLocked } from './workflowCollaborationRuntime.js'
import { parseWorkflowWorkResult } from './workflowCoordinationResult.js'
import { readAcceptedWorkResults, readUnresolvedWork, readUnreturnedWorkRequests, readWorkActivationStates,
  readWorkDenialContinuations } from './workCompletionReads.js'
import { readWorkflowResultEffectFailureLocked, type WorkflowResultEffectFailure } from './workflowResultEffectFailure.js'
import { recordWorkflowCoordinationTerminalLocked } from './workflowCoordinationTerminal.js'
import { readWorkflowControlDispositionLocked } from '../collaboration/workflowControlDisposition.js'
import { completeWorkflowControlContinuationLocked, closeWorkflowControlInputLocked,
  claimWorkflowControlInputLocked, failWorkflowControlContinuationLocked } from '../collaboration/workflowControlStore.js'
import { ControlAdmissionFailure, finalControlAdmissionRefusal, workflowControlFailure } from './workflowControlFailure.js'
import { claimWorkflowCoordinatorGraphLocked } from '../collaboration/workflowConsultations.js'
import { readWorkflowChatIdentity } from '../collaboration/workflowChatIdentity.js'
import { readCoordinatorConsultationLocked } from '../collaboration/workflowConsultations.js'
import type { WorkflowChatLockedTarget, WorkflowChatNativeTarget, WorkflowChatTarget } from '../collaboration/workflowControlTypes.js'
import {
  assertRepeatBodyComplete, assertRepeatExecution, assertRepeatRef, assertRepeatSource,
  bindRepeatNodeInput, blockForNode, decideRepeatAdmission, decideRepeatBlockEntry, decideRepeatExit, finalRepeatExport,
  freezeRepeatEntry, makeRepeatOccurrence, repeatBlock, repeatConflict, repeatDigest,
  repeatExecutionIdentity, repeatId, repeatSlotId, repeatSuccessorInput, sameRepeatValue,
  workActivationSlotId, repeatTickIndex, tickSlotId,
  type RepeatInputBinding, type RepeatNodeRef,
  type RepeatResolution, type RepeatScope, type RepeatSource,
} from './repeatResolution.js'
import { isClosedRunState } from './runState.js'
import * as repeatQueries from './repeatQueries.js'

export { readRepeatExecutionLocked, type StoredRepeatExecution } from './repeatExecutionRead.js'

/** This is an internal projection of the SHELL-validated v3 Run, not a new wire schema. */
export type RepeatRuntimeRun = Pick<WorkflowRunCurrent, 'id' | 'workspaceId' | 'workflowId' | 'workflowVersionId'
  | 'agentConfigurationVersionIds' | 'approval' | 'input' | 'executionState' | 'resultProtocol'> & { executionSemanticsVersion: 3 }
export type RepeatFact =
  | { type: 'repeat.occurrence'; occurrence: RepeatOccurrenceV1 }
  | { type: 'repeat.decision'; decision: RepeatDecisionMetadataV1 }
  | { type: 'repeat.node.resolved'; resolution: RepeatResolution; outside: boolean }
  | { type: 'repeat.execution.queued'; ref: RepeatNodeRef; execution: ReturnType<typeof repeatExecutionIdentity>; inputDigest: string }
  | { type: 'repeat.result.accepted'; ref: RepeatNodeRef; execution: ReturnType<typeof repeatExecutionIdentity>; resultDigest: string }
export interface RepeatEffect {
  kind: 'occurrence.create' | 'input.bind' | 'terminal.accept' | 'node.inactive' | 'run.complete'
  entityId: string
  digest: string
}
/** Required adapter to EXISTING Run/head publication and native/approval guards.
 * Implement in shell-owned wiring. No permissive/no-op/default implementation.
 * All callbacks execute on the same transaction token, with no native/network I/O.
 * publishLocked MUST atomically call mutate and publish bounded metadata (including
 * reset-on-oversize and immutable graph-effect receipts). It MUST NOT commit itself.
 */
export interface RepeatLockedHooks {
  /** Optional only for read/semantics-only hosts. Every native method fails
   * closed unless the complete native capability is installed. */
  native?: RepeatNativeLockedHooks
  collaboration?: WorkflowCollaborationHooks
  validateMemoryResultLocked?(sql: SqlTransaction, execution: HarnessExecution, result: ExecutionResult): Promise<void>
  memoryWorkChangedLocked?(sql: SqlTransaction, executionId: string, sourceEventKey: string): Promise<void>
  prepareMemoryLaunchLocked?(sql: SqlTransaction, execution: HarnessExecution): Promise<HarnessExecution>
  run: RepeatRuntimeRun
  assertAuthorityLocked(sql: SqlTransaction): Promise<void>
  /** SQL-only durable completeness for declared original artifacts. Optional
   * for workflows without declarations; declared success fails closed. */
  assertWorkflowArtifactOutputsLocked?(sql: SqlTransaction, execution: HarnessExecution): Promise<void>
  persistDispatchLocked?(sql: SqlTransaction, execution: HarnessExecution, ref: RepeatNodeRef, inputDigest: string): Promise<void>
  assertAdmissionLocked(sql: SqlTransaction, execution: HarnessExecution, ref: RepeatNodeRef): Promise<void>
  /** Exact terminal approval acknowledgement AND required native/reviewer cleanup;
   * process absence, graph.resume alone, or a delivered response are insufficient. */
  assertSettlementLocked(sql: SqlTransaction, executionIds: readonly string[]): Promise<void>
  /** Existing pinned technical policy only; called after exact negative settlement.
   * False closes the node. True does not change occurrence or permit native dispatch. */
  allowTechnicalRetryLocked(sql: SqlTransaction, execution: HarnessExecution): Promise<boolean>
  publishLocked(sql: SqlTransaction, effect: RepeatEffect, facts: readonly RepeatFact[], mutate: () => Promise<void>): Promise<void>
  assertPublicationReceiptLocked(sql: SqlTransaction, effect: RepeatEffect): Promise<void>
  /** Existing selected-work terminal writer + cleanup intent, in this transaction. */
  completeRunLocked(sql: SqlTransaction, terminals: readonly RepeatSource[]): Promise<void>
}
export interface RepeatRepositoryHost {
  /** Lock order: Run (already held), graph head, exact execution children, receipts.
   * Parse the actual v3 Run union, retain all admission/approval/configuration pins,
   * and open the existing publication. Never initialize a missing history head. */
  openLocked(sql: SqlTransaction, scope: RepeatScope, runRecord: unknown, version: WorkflowVersionCurrent): Promise<RepeatLockedHooks>
}
interface Context {
  sql: SqlTransaction; scope: RepeatScope; version: WorkflowVersionCurrent; hooks: RepeatLockedHooks
  stopped: boolean; cleanup: boolean; now: string; fence: { ownerId: string; fence: string }
}
export type RepeatTickAdmission = { kind: 'busy'; execution?: HarnessExecution }
  | { kind: 'wait'; dueAt: string | null } | { kind: 'admitted'; execution: HarnessExecution }
export type WorkTerminalAcceptance = { kind: 'accepted'; execution: HarnessExecution; replayed: boolean;
  resultProtocol?: ResultProtocol }
  | { kind: 'retry'; execution: HarnessExecution }
  | { kind: 'continued'; execution: HarnessExecution }
  | { kind: 'waiting_direction'; execution: HarnessExecution; activationId: string; replayed: boolean }
  | { kind: 'refused'; execution: HarnessExecution; code: string; replayed: boolean }
const BindingSchema = z.object({
  bindingId: GraphIdSchema, recipient: GraphExecutionIdentitySchema,
  recipientOccurrence: RepeatOccurrenceIdentityV1Schema.nullable(), inputDigest: GraphDigestSchema,
  source: z.union([SourceSchema, EntrySchema.shape.carry.unwrap()]),
  kind: z.enum(['predecessor', 'external', 'carry']), ordinal: z.number().int().min(0).max(16000),
}).strict()
const ResolutionSchema = z.object({
  ref: z.object({ nodeId: GraphIdSchema, occurrence: RepeatOccurrenceIdentityV1Schema.nullable() }).strict(),
  value: NodeResolutionSchema, deferredRelationshipIds: z.array(GraphIdSchema).max(8000),
}).strict()

/** Read helpers are authorization-neutral. B must authorize scope/detail before use.
 * These bounded reads never acquire an execution owner or progress an occurrence. */
export async function readRepeatOccurrences(sql: SqlQuery, scope: RepeatScope, blockId: string,
  afterIndex = 0, limit = 100): Promise<RepeatOccurrenceV1[]> {
  if (!Number.isInteger(limit) || limit < 1 || limit > 1000 || !Number.isInteger(afterIndex) || afterIndex < 0) return repeatConflict('REPEAT_READ_BOUND_INVALID')
  const rows = await repeatQueries.readOccurrencePage(sql, {
    runId: scope.runId, workspaceId: scope.workspaceId, workflowId: scope.workflowId,
    workflowVersionId: scope.workflowVersionId, blockId, afterIndex, limit
  })
  return rows.rows.map((row) => {
    const value = RepeatOccurrenceV1Schema.parse(row.record)
    if (!sameRepeatValue(value.identity.scope, scope) || value.identity.blockId !== blockId
      || value.identity.occurrenceIndex <= afterIndex) return repeatConflict('REPEAT_SCOPE_CONFLICT')
    return value
  })
}
export async function readRepeatDecision(sql: SqlQuery, scope: RepeatScope,
  occurrenceId: string): Promise<RepeatDecisionMetadataV1 | undefined> {
  const rows = await repeatQueries.readDecisionMetadata(sql, {
    occurrenceId, runId: scope.runId, workspaceId: scope.workspaceId, workflowId: scope.workflowId,
    workflowVersionId: scope.workflowVersionId
  })
  if (!rows.rows[0]) return undefined
  const value = RepeatDecisionMetadataV1Schema.parse(rows.rows[0].record)
  if (!sameRepeatValue(value.occurrence.identity.scope, scope) || value.occurrence.identity.occurrenceId !== occurrenceId) return repeatConflict('REPEAT_SCOPE_CONFLICT')
  return value
}

/** Durable bookkeeping using the EXISTING dedicated owner connection. No scheduler,
 * native launch, approval delivery, terminal rewrite, new owner, or detached pool. */
class MemoryValidationComplete extends Error {}

export class RepeatRunRepository {
  constructor(private readonly owner: Pick<RunOwnership, 'runId' | 'assertOwned' | 'oneShotConnection' | 'readOneShotFence'>,
    private readonly host: RepeatRepositoryHost, expectedVersion: WorkflowVersionCurrent) {
    this.expectedVersion = WorkflowVersionCurrentSchema.parse(expectedVersion)
    if (!host || typeof host.openLocked !== 'function') repeatConflict('REPEAT_SHELL_WIRING_REQUIRED')
  }
  private readonly expectedVersion: WorkflowVersionCurrent
  private readonly launchPermits = new Set<string>()

  /** A durable claim read after recovery cannot reconstruct this one-use permit. */
  consumeLaunchPermit(executionId: string): boolean {
    this.owner.assertOwned()
    if (this.owner.oneShotConnection().unusable) return false
    return this.launchPermits.delete(executionId)
  }
  private async transaction<T>(work: (context: Context) => Promise<T>, options: { readOnly?: boolean } = {}): Promise<T> {
    return this.owner.oneShotConnection().transaction(async (sql) => {
      this.owner.assertOwned()
      const found = await repeatQueries.readRunSnapshot(sql, this.owner.runId, options.readOnly)
      const row = found.rows[0]
      if (!row) return repeatConflict('RUN_NOT_FOUND')
      const version = WorkflowVersionCurrentSchema.parse(row.version)
      if (!sameRepeatValue(version, this.expectedVersion)) return repeatConflict('RUN_PIN_CONFLICT')
      const scope: RepeatScope = { workspaceId: version.workspaceId, workflowId: version.workflowId,
        workflowVersionId: version.id, runId: this.owner.runId, executionSemanticsVersion: 3 }
      const hooks = await this.host.openLocked(sql, scope, row.run, version)
      const run = hooks.run
      if (run.executionSemanticsVersion !== 3 || run.id !== scope.runId || run.workspaceId !== scope.workspaceId
        || run.workflowId !== scope.workflowId || run.workflowVersionId !== scope.workflowVersionId || run.executionState !== row.state
        || !sameRepeatValue(run.agentConfigurationVersionIds, version.agentConfigurationVersionIds)
        || !sameRepeatValue(run.approval, version.approval)) return repeatConflict('RUN_PIN_CONFLICT')
      const fence = await this.owner.readOneShotFence(sql)
      // Recheck after publication/receipt finalizers, not merely before staging.
      const result = await work({ sql, scope, version, hooks, stopped: row.stopped, cleanup: row.cleanup, now: new Date(row.now).toISOString(), fence })
      if (!sameRepeatValue(fence, await this.owner.readOneShotFence(sql))) return repeatConflict('RUN_OWNERSHIP_LOST')
      beforeGraphCommit(sql, async () => {
        if (!sameRepeatValue(fence, await this.owner.readOneShotFence(sql))) return repeatConflict('RUN_OWNERSHIP_LOST')
      })
      return result
    }, options.readOnly)
  }
  private active(context: Context): void {
    if (context.stopped || context.cleanup) repeatConflict('GRAPH_STOP_CONFLICT')
    if (isClosedRunState(context.hooks.run.executionState)) repeatConflict('GRAPH_TERMINAL_CONFLICT')
  }
  /** Commands join this owner's ordinary Run/head/slot transaction. The
   * captured native writer is rechecked inside it, without native I/O. */
  workflowChatTransaction<T>(target: WorkflowChatTarget, native: WorkflowChatNativeTarget | undefined,
    assertNative: () => void, work: (context: WorkflowChatLockedTarget) => Promise<T>): Promise<T> {
    return this.transaction(async context => {
      const identity = await readWorkflowChatIdentity(context.sql, target)
      if (!sameRepeatValue(identity.version, context.version) || identity.run.id !== context.scope.runId) {
        return repeatConflict('CHAT_TARGET_MISMATCH')
      }
      assertNative()
      await context.hooks.assertAuthorityLocked(context.sql)
      let execution: HarnessExecution | undefined
      let accepted: boolean
      let logicalWork: WorkflowChatLockedTarget['work'], waiting: WorkflowChatLockedTarget['waiting']
      if (target.kind === 'workflow_execution') {
        const stored = await this.execution(context, target.execution.executionId)
        await this.recordedEffect(context, 'input.bind', stored.execution.id)
        execution = stored.execution
        accepted = stored.accepted
        logicalWork = stored.workActivationId
          ? { kind: 'activation', runId: execution.runId, workflowVersionId: context.version.id, activationId: stored.workActivationId }
          : { kind: 'slot', runId: execution.runId, workflowVersionId: context.version.id, slotId: stored.slotId }
        if (native && native.nativeSessionId !== execution.nativeSessionId) return repeatConflict('CHAT_NATIVE_TARGET_CHANGED')
      } else {
        const group = (await repeatQueries.readWaitingHierarchyGroup(context.sql,
          context.scope.runId, target.waitingActivationId, target.agent.workflowNodeId)).rows[0]
        if (!group) return repeatConflict('COORDINATOR_UNAVAILABLE')
        const source = await this.execution(context, group.parent_execution_id)
        if (!source.accepted || source.execution.state !== 'completed' || !source.execution.nativeSessionId) {
          return repeatConflict('COORDINATOR_NATIVE_SOURCE_PENDING')
        }
        const consultation = await readCoordinatorConsultationLocked(context.sql, context.scope.runId, target.waitingActivationId)
        const sessionId = consultation?.binding.nativeSessionId ?? source.execution.nativeSessionId
        if (native && native.nativeSessionId !== sessionId) return repeatConflict('CHAT_NATIVE_TARGET_CHANGED')
        waiting = { delegationGroupId: group.group_id, waitingActivationId: target.waitingActivationId,
          nativeSessionId: sessionId, sourceExecution: { runId: context.scope.runId, workflowVersionId: context.version.id,
            executionId: source.execution.id, attempt: source.execution.attempt, activationId: target.waitingActivationId } }
        accepted = group.state === 'continued' || group.state === 'canceled'
      }
      const result = await work({ sql: context.sql, run: context.hooks.run, version: context.version,
        target, agent: identity.agent, state: identity.state,
        ...(execution ? { execution, work: logicalWork } : {}), ...(waiting ? { waiting } : {}),
        ...(native ? { native } : {}), accepted,
        stopping: context.stopped || context.cleanup })
      assertNative()
      return result
    })
  }

  /** Only the already admitted execution's existing input boundary can claim a
   * queued message. Its content remains outside immutable execution.input. */
  workflowControlDisposition(executionId: string) {
    return this.transaction(async context => {
      await this.execution(context, executionId)
      await this.recordedEffect(context, 'input.bind', executionId)
      return readWorkflowControlDispositionLocked(context.sql, context.scope.runId, executionId)
    })
  }
  claimWorkflowInput(executionId: string) {
    return this.transaction(async context => {
      this.active(context)
      const stored = await this.execution(context, executionId)
      await this.recordedEffect(context, 'input.bind', executionId)
      if (stored.accepted || stored.execution.state === 'completed') return undefined
      await context.hooks.assertAuthorityLocked(context.sql)
      const entry = await readWorkflowNativeEntryLocked(context.sql,
        workflowNativeReservation(context.scope, stored.ref, stored.execution, stored.inputDigest))
      return claimWorkflowControlInputLocked(context.sql, { now: context.now,
        claimNew: entry.phase === 'reserved' || entry.phase === 'prepared', execution: {
        runId: context.scope.runId, workflowVersionId: context.version.id,
        executionId, attempt: stored.execution.attempt,
        ...(stored.workActivationId ? { activationId: stored.workActivationId } : {}),
      } })
    })
  }
  admitHierarchyGroup(sourceExecutionId: string): Promise<HierarchyGroupAdmission> {
    return this.transaction(context => admitHierarchyGroupLocked({ ...context,
      assertActive: () => this.active(context) }, sourceExecutionId))
  }
  /** The connection on which a finished Worker reports back to the Orchestrator that asked for its work. */
  readWorkCallerReport(sourceExecutionId: string): Promise<string | undefined> {
    return this.transaction(context => readWorkCallerReportLocked({ ...context,
      assertActive: () => this.active(context) }, sourceExecutionId))
  }
  /** One business request on the already-owned Run; replay returns its first receipt. */
  admitWorkRequest(sourceExecutionId: string, selectedRelationshipId?: string): Promise<WorkRequestAdmission> {
    return this.transaction(async context => {
      const receipt = await admitWorkHandoffLocked({ ...context, assertActive: () => this.active(context) },
        sourceExecutionId, selectedRelationshipId)
      let id: string
      if (receipt.kind === 'accepted') id = receipt.request.requestId
      else if (receipt.kind === 'limit_reached') id = receipt.denial.denialId
      else id = receipt.unresolvedId
      if (!receipt.replayed) await context.hooks.memoryWorkChangedLocked?.(context.sql, sourceExecutionId, `request:${id}`)
      return receipt
    })
  }
  returnWork(sourceExecutionId: string): Promise<WorkReturnReceipt> {
    return this.transaction(async context => {
      const receipt = await returnWorkHandoffLocked({ ...context, assertActive: () => this.active(context) }, sourceExecutionId)
      if (!receipt.replayed) await context.hooks.memoryWorkChangedLocked?.(context.sql, sourceExecutionId,
        `return:${receipt.value.returnId}`)
      return receipt
    })
  }
  recordWorkUnresolved(sourceExecutionId: string): Promise<{ unresolvedId: string; replayed: boolean }> {
    return this.transaction(async context => {
      const receipt = await recordUnresolvedWorkLocked({ ...context, assertActive: () => this.active(context) },
        sourceExecutionId, 'finish_with_findings')
      if (!receipt.replayed) await context.hooks.memoryWorkChangedLocked?.(context.sql, sourceExecutionId,
        `unresolved:${receipt.unresolvedId}`)
      return receipt
    })
  }
  resolveWaitingWorkJoins(sourceActivationId: string): Promise<string[]> {
    return this.transaction((context) => resolveWaitingWorkJoinsLocked({ ...context,
      assertActive: () => this.active(context),
    }, sourceActivationId))
  }
  ensureWorkEntry(): Promise<string> {
    return this.transaction((context) => ensureWorkEntryLocked({ ...context,
      assertActive: () => this.active(context),
    }))
  }
  readWorkExecutionContext(executionId: string): Promise<HarnessExecutionContext> {
    return this.transaction(async (context) => {
      this.active(context)
      await context.hooks.assertAuthorityLocked(context.sql)
      const stored = await this.execution(context, executionId)
      await this.recordedEffect(context, 'input.bind', executionId)
      if (!stored.workActivationId) return repeatConflict('WORK_ACTIVATION_MISSING')
      const input = await readWorkActivationInputLocked({ ...context,
        assertActive: () => this.active(context),
      }, stored.workActivationId)
      assertWorkActivationReplay(stored, input)
      if (context.hooks.run.resultProtocol || isHierarchyWorkflow(context.version)) {
        return (await readWorkResultContextLocked(context, stored.workActivationId, stored.input,
          context.hooks.run.resultProtocol))!
      }
      return { parentRequest: input.parentRequest ? {
        requestId: input.parentRequest.requestId,
        requesterNodeId: input.parentRequest.requesterNodeId,
      } : null }
    })
  }
  /** Queue one exact activation through the existing native receipt and launch path. */
  admitWorkActivation(activationId: string, candidate: (nodeId: string) => HarnessExecution): Promise<{ execution: HarnessExecution; reused: boolean }> {
    return this.transaction(context => withNativeGraphProjectionBatch(context.sql, context.scope.runId, async () => {
      this.active(context)
      await context.hooks.assertAuthorityLocked(context.sql)
      const input = await readWorkActivationInputLocked({ ...context,
        assertActive: () => this.active(context),
      }, activationId)
      if (input.work.kind === 'hierarchy_direction') {
        await assertHierarchyDirectionReleasedLocked(context.sql, context.scope.runId, input.work.direction.heldExecutionId)
      }
      if (input.work.kind === 'hierarchy_group' && !await claimWorkflowCoordinatorGraphLocked(context.sql, {
        runId: context.scope.runId, groupId: input.work.group.groupId, now: context.now,
      })) return repeatConflict('COORDINATOR_CONSULTATION_ACTIVE')
      return this.bindWorkActivation(context, input, candidate)
    }))
  }

  private async bindWorkActivation(context: Context, input: WorkActivationInput,
    candidate: (nodeId: string) => HarnessExecution, held = false): Promise<{ execution: HarnessExecution; reused: boolean }> {
    const activationId = input.work.activation.activationId
    const ref: RepeatNodeRef = { nodeId: input.work.activation.workflowNodeId, occurrence: null }
    const slotId = workActivationSlotId(context.scope.runId, activationId)
    const previous = (await repeatQueries.readLatestWorkExecution(context.sql, context.scope.runId, slotId)).rows[0]
    if (previous) {
      await this.recordedEffect(context, 'input.bind', previous.execution_id)
      const stored = await this.execution(context, previous.execution_id)
      assertWorkActivationReplay(stored, input)
      return { execution: stored.execution, reused: true }
    }
    const state = (await repeatQueries.readWorkActivationState(context.sql, context.scope.runId, activationId)).rows[0]
    if (state?.state !== 'queued' && !(held && state?.state === 'waiting')) return repeatConflict('WORK_ACTIVATION_NOT_QUEUED')
    // One execution of a node at a time: graph work waits for the node's running interval check.
    const checking = await repeatQueries.readRunningIntervalCheck(context.sql, context.scope.runId, ref.nodeId)
    if (checking.rowCount) return repeatConflict('INTERVAL_CHECK_RUNNING')
    const execution = HarnessExecutionSchema.parse(candidate(ref.nodeId))
    this.assertCandidate(context, ref, execution, 1)
    const queued = HarnessExecutionSchema.parse({ ...execution, input })
    const inputDigest = repeatDigest(input, 4 * 1024 * 1024)
    await context.hooks.assertAdmissionLocked(context.sql, queued, ref)
    await this.effect(context, 'input.bind', queued.id,
      { ref, queued, inputDigest, bindings: [], workActivationId: activationId },
      [{ type: 'repeat.execution.queued', ref, execution: repeatExecutionIdentity(queued), inputDigest }], async () => {
        await repeatQueries.insertWorkSlot(context.sql, {
          slotId, runId: context.scope.runId, activationId, nodeId: ref.nodeId,
          inputJson: canonicalGraphJson(input, 4 * 1024 * 1024), inputDigest
        })
        await this.insertExecution(context, ref, queued, slotId, inputDigest, [], null, activationId)
        await markWorkNoticePendingLocked(context, activationId, queued.id)
        if (input.work.kind === 'hierarchy_group') {
          await markHierarchyContinuationStartedLocked({ ...context,
            assertActive: () => this.active(context) }, activationId)
        }
      })
    return { execution: queued, reused: false }
  }
  /** Settle one exact native attempt before accepting its work result. A
   * technical retry stays in the same activation and never reserves a handoff. */
  acceptWorkTerminal(executionId: string, candidate: (attempt: number) => HarnessExecution): Promise<WorkTerminalAcceptance> {
    return this.transaction<WorkTerminalAcceptance | { kind: 'control_failed'; result: ExecutionResult }>(async (context) => {
      if (!usesWorkHandoffGraph(context.version)) return repeatConflict('WORK_POLICY_PIN_CONFLICT')
      const stored = await this.execution(context, executionId)
      if (!stored.workActivationId) return repeatConflict('WORK_ACTIVATION_MISSING')
      await this.recordedEffect(context, 'input.bind', executionId)
      const controlled = await this.continueControlledExecution(context, stored)
      if (controlled) return controlled
      if (isHierarchyWorkflow(context.version)) {
        const direction = await readHierarchyDirectionForSourceLocked({ ...context,
          assertActive: () => this.active(context) }, executionId)
        if (direction) {
          if (stored.accepted || direction.sourceResultDigest !== repeatDigest(stored.execution.result, 64 * 1024)) {
            return repeatConflict('HIERARCHY_DIRECTION_REPLAY_CONFLICT')
          }
          await this.recordedEffect(context, 'input.bind', direction.heldExecutionId)
          return { kind: 'waiting_direction', execution: (await this.execution(context, direction.heldExecutionId)).execution,
            activationId: direction.heldActivationId, replayed: true }
        }
      }
      const prior = (await repeatQueries.readWorkResult(context.sql, context.scope.runId, executionId)).rows[0]
      if (prior) {
        if (!stored.accepted || stored.execution.state !== 'completed'
          || prior.result_json !== canonicalGraphJson(stored.execution.result, 64 * 1024)
          || prior.result_digest !== repeatDigest(stored.execution.result, 64 * 1024)) {
          return repeatConflict('WORK_TERMINAL_REPLAY_CONFLICT')
        }
        await this.recordedEffect(context, 'terminal.accept', executionId)
        await this.assertArtifactOutputs(context, stored.execution)
        return { kind: 'accepted', execution: stored.execution, replayed: true,
          ...(context.hooks.run.resultProtocol ? { resultProtocol: context.hooks.run.resultProtocol } : {}) }
      }
      this.active(context)
      await this.settleAttempts(context, { kind: 'slot', id: stored.slotId, throughAttempt: stored.execution.attempt })
      const retry = (await repeatQueries.readSuccessorExecution(context.sql, executionId)).rows[0]
      if (retry) {
        await this.recordedEffect(context, 'input.bind', retry.execution_id)
        const next = await this.execution(context, retry.execution_id)
        if (next.workActivationId !== stored.workActivationId) return repeatConflict('WORK_RETRY_ACTIVATION_CONFLICT')
        return { kind: 'retry', execution: next.execution }
      }
      if (stored.execution.state !== 'completed' || !stored.execution.result) return repeatConflict('WORK_TERMINAL_PENDING')
      if (stored.execution.result.outcome === 'failed' && stored.execution.result.error?.retryable
        && await context.hooks.allowTechnicalRetryLocked(context.sql, stored.execution)) {
        if (stored.accepted || stored.execution.attempt >= 2147483647) return repeatConflict('WORK_RETRY_NOT_ALLOWED')
        const replacement = HarnessExecutionSchema.parse(candidate(stored.execution.attempt + 1))
        this.assertCandidate(context, stored.ref, replacement, stored.execution.attempt + 1)
        const queued = HarnessExecutionSchema.parse({ ...replacement, input: stored.input })
        await context.hooks.assertAdmissionLocked(context.sql, queued, stored.ref)
        await this.effect(context, 'input.bind', queued.id,
          { previousExecutionId: executionId, queued, inputDigest: stored.inputDigest,
            bindings: [], workActivationId: stored.workActivationId },
          [{ type: 'repeat.execution.queued', ref: stored.ref,
            execution: repeatExecutionIdentity(queued), inputDigest: stored.inputDigest }],
          () => this.insertExecution(context, stored.ref, queued, stored.slotId, stored.inputDigest,
            [], executionId, stored.workActivationId))
        return { kind: 'retry', execution: queued }
      }
      if (stored.execution.result.outcome === 'failed') throw new WorkExecutionFailure(stored.execution.result)
      if (stored.execution.result.outcome === 'canceled') throw new WorkExecutionFailure(stored.execution.result)
      if (stored.execution.result.outcome !== 'succeeded') return repeatConflict('WORK_SELECTED_EXECUTION_FAILED')
      await this.assertArtifactOutputs(context, stored.execution)
      const result = AcceptedCurrentNodeResultSchema.parse(stored.execution.result)
      const workResult = await parseWorkResultLocked(context, stored.execution, stored.workActivationId)
      await assertWorkHandoffDeliveryLocked(context, stored.execution, stored.workActivationId, workResult)
      if (isHierarchyWorkflow(context.version)
        && workResult.routing.kind === 'finish' && workResult.data.remainingFindings.length) {
        const heldCandidate = candidate(1)
        const reserved = await reserveHierarchyDirectionLocked({ ...context,
          assertActive: () => this.active(context) }, stored.execution, stored.workActivationId, heldCandidate.id)
        if (reserved.kind === 'refused') return { ...reserved, execution: stored.execution }
        const held = await this.bindWorkActivation(context, reserved.input, () => heldCandidate, true)
        await closeWorkflowControlInputLocked(context.sql, { runId: context.scope.runId, executionId, now: context.now })
        return { kind: 'waiting_direction', execution: held.execution,
          activationId: reserved.direction.heldActivationId, replayed: reserved.replayed }
      }
      const resultJson = canonicalGraphJson(result, 64 * 1024), resultDigest = repeatDigest(result, 64 * 1024)
      await this.effect(context, 'terminal.accept', executionId,
        { execution: stored.execution, resultDigest, workActivationId: stored.workActivationId },
        [{ type: 'repeat.result.accepted', ref: stored.ref,
          execution: repeatExecutionIdentity(stored.execution), resultDigest }], async () => {
          await repeatQueries.insertWorkRepeatResult(context.sql, {
            executionId, runId: context.scope.runId, resultJson, resultDigest, acceptedAt: context.now
          })
          await repeatQueries.insertWorkResult(context.sql, {
            executionId, runId: context.scope.runId, activationId: stored.workActivationId, resultJson, resultDigest,
            acceptedAt: context.now
          })
          await repeatQueries.acceptExecution(context.sql, executionId, context.scope.runId)
          // Input still queued for this finished turn waits for the Agent's next turn; the Run's end closes the rest.
          await repeatQueries.completeWorkActivation(context.sql, context.scope.runId, stored.workActivationId)
          await markWorkNoticeDeliveredLocked(context, stored.workActivationId!, executionId)
          await repeatQueries.insertWorkResultActivity(context.sql,
            context.scope.runId, executionId, context.now,
            canonicalGraphJson({ activationId: stored.workActivationId, resultDigest, workflowNodeId: stored.ref.nodeId }))
        })
      if (isHierarchyWorkflow(context.version)
        && (workResult.routing.kind === 'delegate' || workResult.routing.kind === 'request')) {
        const group = await admitHierarchyGroupLocked({ ...context, assertActive: () => this.active(context) }, executionId)
        if (group.kind === 'refused') return { kind: 'refused', execution: stored.execution,
          code: group.code, replayed: group.replayed }
      } else if (workResult.routing.kind === 'finish' && !workResult.data.remainingFindings.length) {
        await workflowLifecycleLocked(context, stored.execution, 'accepted', `workflow:${executionId}:accepted`)
      }
      return { kind: 'accepted', execution: stored.execution, replayed: false,
        ...(context.hooks.run.resultProtocol ? { resultProtocol: context.hooks.run.resultProtocol } : {}) }
    }).then(value => {
      if (value.kind === 'control_failed') throw new WorkExecutionFailure(value.result)
      return value
    }).catch(error => this.failControlAdmission(executionId, error))
  }
  private async assertArtifactOutputs(context: Context, execution: HarnessExecution): Promise<void> {
    const node = context.version.definition.nodes.find(node => node.id === execution.workflowNodeId)
    if (node?.kind === 'job' || !node?.artifactOutputs || execution.result?.outcome !== 'succeeded') return
    await context.hooks.assertAuthorityLocked(context.sql)
    if (!context.hooks.assertWorkflowArtifactOutputsLocked) return repeatConflict('WORKFLOW_ARTIFACT_OUTPUTS_UNAVAILABLE')
    await context.hooks.assertWorkflowArtifactOutputsLocked(context.sql, execution)
  }
  /** A durable control reservation owns this same slot. Native closure is
   * proved by the ordinary settlement gate before the one reserved ID binds. */
  private async continueControlledExecution(context: Context, stored: StoredRepeatExecution): Promise<
    { kind: 'continued'; execution: HarnessExecution } | { kind: 'control_failed'; result: ExecutionResult } | undefined> {
    const disposition = await readWorkflowControlDispositionLocked(context.sql, context.scope.runId, stored.execution.id)
    const failure = workflowControlFailure(disposition)
    if (failure) {
      this.active(context)
      await this.settleAttempts(context, { kind: 'slot', id: stored.slotId, throughAttempt: stored.execution.attempt })
      await closeWorkflowControlInputLocked(context.sql, { runId: context.scope.runId, executionId: stored.execution.id, now: context.now })
      await workflowLifecycleLocked(context, stored.execution, failure.outcome === 'canceled' ? 'canceled' : 'failed',
        `workflow:${stored.execution.id}:control-settled`, { reason: failure.error!.message })
      return { kind: 'control_failed', result: failure }
    }
    if (disposition.kind !== 'superseded') return undefined
    const continuation = disposition.continuation
    if (continuation.state === 'admitted') {
      const successor = await this.execution(context, disposition.reservedSuccessorExecutionId)
      if (successor.slotId !== stored.slotId || successor.execution.attempt !== stored.execution.attempt + 1) {
        return repeatConflict('CONTROL_SUCCESSOR_CONFLICT')
      }
      await this.recordedEffect(context, 'input.bind', successor.execution.id)
      return { kind: 'continued', execution: successor.execution }
    }
    this.active(context)
    if (stored.accepted || stored.execution.state !== 'completed' || stored.execution.attempt >= 2147483647) {
      return repeatConflict('CONTROL_NATIVE_SETTLEMENT_PENDING')
    }
    await this.settleAttempts(context, { kind: 'slot', id: stored.slotId, throughAttempt: stored.execution.attempt })
    const queued = HarnessExecutionSchema.parse({ id: disposition.reservedSuccessorExecutionId,
      runId: stored.execution.runId, workflowNodeId: stored.execution.workflowNodeId, agentId: stored.execution.agentId,
      agentConfigurationVersionId: stored.execution.agentConfigurationVersionId,
      attempt: stored.execution.attempt + 1, input: stored.input, state: 'queued', createdAt: context.now })
    this.assertCandidate(context, stored.ref, queued, stored.execution.attempt + 1)
    try { await context.hooks.assertAdmissionLocked(context.sql, queued, stored.ref) }
    catch (error) {
      if (finalControlAdmissionRefusal(error)) throw new ControlAdmissionFailure((error as { code: string }).code, error)
      throw error
    }
    const rows = await repeatQueries.readBindings(context.sql, stored.execution.id)
    const bindings = rows.rows.map(row => {
      const binding = BindingSchema.parse(row.record) as RepeatInputBinding
      if (!sameRepeatValue(binding.recipient, repeatExecutionIdentity(stored.execution))
        || !sameRepeatValue(binding.recipientOccurrence, stored.ref.occurrence)
        || binding.inputDigest !== stored.inputDigest) return repeatConflict('REPEAT_BINDING_CONFLICT')
      return { ...binding, bindingId: repeatId('repeat-binding', queued.id, binding.kind, binding.ordinal),
        recipient: repeatExecutionIdentity(queued) }
    })
    await this.effect(context, 'input.bind', queued.id, { previousExecutionId: stored.execution.id,
      controlContinuationId: continuation.id, queued, inputDigest: stored.inputDigest, bindings,
      workActivationId: stored.workActivationId ?? null },
    [{ type: 'repeat.execution.queued', ref: stored.ref, execution: repeatExecutionIdentity(queued), inputDigest: stored.inputDigest }],
    () => this.insertExecution(context, stored.ref, queued, stored.slotId, stored.inputDigest, bindings,
      stored.execution.id, stored.workActivationId ?? null, continuation))
    return { kind: 'continued', execution: queued }
  }

  private async failControlAdmission(executionId: string, error: unknown): Promise<never> {
    if (!(error instanceof ControlAdmissionFailure)) throw error
    const failure = await this.transaction(async context => {
      this.active(context)
      const stored = await this.execution(context, executionId)
      const disposition = await readWorkflowControlDispositionLocked(context.sql, context.scope.runId, executionId)
      if (disposition.kind !== 'superseded' || disposition.continuation.state === 'admitted') throw error
      await this.settleAttempts(context, { kind: 'slot', id: stored.slotId, throughAttempt: stored.execution.attempt })
      await failWorkflowControlContinuationLocked(context.sql, { runId: context.scope.runId,
        continuationId: disposition.continuation.id, errorCode: error.errorCode, now: context.now })
      const current = await this.continueControlledExecution(context, stored)
      if (current?.kind !== 'control_failed') return repeatConflict('CONTROL_SUCCESSOR_CONFLICT')
      return current.result
    })
    throw new WorkExecutionFailure(failure)
  }
  private async effect(context: Context, kind: RepeatEffect['kind'], entityId: string, value: unknown,
    facts: RepeatFact[], mutate: () => Promise<void>): Promise<void> {
    this.active(context)
    await context.hooks.assertAuthorityLocked(context.sql)
    const effect: RepeatEffect = { kind, entityId, digest: repeatDigest(value) }
    const prior = await repeatQueries.readEffect(context.sql, context.scope.runId, kind, entityId)
    if (prior.rows[0]) {
      if (prior.rows[0].payload_digest !== effect.digest) return repeatConflict('REPEAT_EFFECT_CONFLICT')
      await context.hooks.assertPublicationReceiptLocked(context.sql, effect)
      return
    }
    let mutations = 0
    await context.hooks.publishLocked(context.sql, effect, facts, async () => {
      if (++mutations !== 1) return repeatConflict('REPEAT_PUBLICATION_CONFLICT')
      await mutate()
      await repeatQueries.insertEffect(context.sql, {
        runId: context.scope.runId, kind, entityId, digest: effect.digest, ownerId: context.fence.ownerId,
        ownerFence: context.fence.fence
      })
    })
    if (mutations !== 1) return repeatConflict('REPEAT_PUBLICATION_CONFLICT')
    // A successful callback alone is not a canonical publication receipt.
    await context.hooks.assertPublicationReceiptLocked(context.sql, effect)
  }
  private async recordedEffect(context: Context, kind: RepeatEffect['kind'], entityId: string): Promise<void> {
    const rows = await repeatQueries.readEffect(context.sql, context.scope.runId, kind, entityId)
    const digest = rows.rows[0]?.payload_digest
    if (!digest || !GraphDigestSchema.safeParse(digest).success) return repeatConflict('REPEAT_EFFECT_MISSING')
    await context.hooks.assertPublicationReceiptLocked(context.sql, { kind, entityId, digest })
  }
  private async occurrenceReceipt(context: Context, value: RepeatOccurrenceV1): Promise<void> {
    if (!value.input.previous) return this.recordedEffect(context, 'occurrence.create', value.identity.occurrenceId)
    const rows = await repeatQueries.readDecision(context.sql, value.input.previous.occurrenceId)
    if (!rows.rows[0]) return repeatConflict('REPEAT_DECISION_MISSING')
    const previous = RepeatDecisionV1Schema.parse(rows.rows[0].record)
    if (previous.decisionId !== value.input.previous.decisionId || previous.acceptedResultDigest !== value.input.previous.acceptedResultDigest
      || previous.reason !== 'repeat' || !sameRepeatValue(previous.occurrence.identity.scope, context.scope)) return repeatConflict('REPEAT_ANCESTRY_CONFLICT')
    await this.recordedEffect(context, 'terminal.accept', previous.exitExecution.executionId)
  }
  private async occurrence(context: Context, id: string): Promise<StoredOccurrence> {
    return readStoredRepeatOccurrence(context.sql, context.scope, id)
  }
  private async putOccurrence(context: Context, value: StoredOccurrence): Promise<void> {
    const occurrence = RepeatOccurrenceV1Schema.parse(value.occurrence), identity = occurrence.identity, previous = occurrence.input.previous
    await repeatQueries.insertOccurrence(context.sql, {
      occurrenceId: identity.occurrenceId, runId: identity.scope.runId, workspaceId: identity.scope.workspaceId,
      workflowId: identity.scope.workflowId, workflowVersionId: identity.scope.workflowVersionId,
      blockId: identity.blockId, occurrenceIndex: identity.occurrenceIndex, bindingId: occurrence.input.bindingId,
      inputJson: canonicalGraphJson(value.input, 4 * 1024 * 1024), inputDigest: occurrence.input.inputDigest,
      previousOccurrenceId: previous?.occurrenceId ?? null, previousOccurrenceIndex: previous?.occurrenceIndex ?? null,
      previousDecisionId: previous?.decisionId ?? null, previousResultDigest: previous?.acceptedResultDigest ?? null,
      record: JSON.stringify(occurrence)
    })
  }
  private async resolutions(context: Context, occurrenceId: string | null): Promise<Map<string, RepeatResolution>> {
    const rows = await repeatQueries.readResolutions(context.sql, context.scope.runId, occurrenceId ?? '')
    if (rows.rows.length > 1000) return repeatConflict('REPEAT_RESOLUTION_BOUND_EXCEEDED')
    const result = new Map<string, RepeatResolution>()
    for (const row of rows.rows) {
      const value = ResolutionSchema.parse(row.record)
      if (occurrenceId && value.ref.occurrence?.occurrenceId !== occurrenceId) return repeatConflict('REPEAT_CROSS_OCCURRENCE_JOIN')
      if (value.ref.nodeId !== value.value.workflowNodeId || result.has(value.ref.nodeId)) return repeatConflict('REPEAT_RESOLUTION_CONFLICT')
      result.set(value.ref.nodeId, value)
    }
    return result
  }
  private async putResolution(context: Context, resolution: RepeatResolution, outside = false): Promise<void> {
    ResolutionSchema.parse(resolution)
    await repeatQueries.insertResolution(context.sql, {
      runId: context.scope.runId, occurrenceKey: outside ? '' : resolution.ref.occurrence?.occurrenceId ?? '',
      nodeId: resolution.ref.nodeId, sourceOccurrenceId: resolution.ref.occurrence?.occurrenceId ?? null,
      executionId: resolution.value.execution?.executionId ?? null, record: JSON.stringify(resolution)
    })
  }
  private async execution(context: Context, executionId: string): Promise<StoredRepeatExecution> {
    return readStoredRepeatExecution(context.sql, context.scope, context.version, executionId, 'update')
  }
  private async acceptedSource(context: Context, row: RepeatResolution, relationshipId: string): Promise<RepeatSource> {
    const identity = row.value.execution
    if (!identity || row.value.resolution !== 'succeeded' || !row.value.acceptedResultDigest) return repeatConflict('REPEAT_INPUT_NOT_ACCEPTED')
    if (identity.kind === 'job') {
      return readWorkflowJobSourceLocked(context.sql, context.scope, context.version, row, relationshipId)
    }
    const stored = await this.execution(context, identity.executionId)
    const result = await repeatQueries.readAcceptedResult(context.sql, identity.executionId, context.scope.runId)
    const accepted = result.rows[0]
    if (!accepted || accepted.result_digest !== row.value.acceptedResultDigest) return repeatConflict('REPEAT_INPUT_NOT_ACCEPTED')
    const source: RepeatSource = { relationshipId, execution: identity, occurrence: row.ref.occurrence,
      acceptedResultDigest: accepted.result_digest, acceptedResult: AcceptedCurrentNodeResultSchema.parse(JSON.parse(accepted.result_json)) }
    if (!sameRepeatValue(stored.ref, row.ref)) return repeatConflict('REPEAT_INPUT_NOT_ACCEPTED')
    assertRepeatSource(context.version, context.scope, source, stored.execution, stored.accepted)
    return source
  }
  private async inactive(context: Context, ref: RepeatNodeRef, kind: 'skipped' | 'excluded'): Promise<RepeatResolution> {
    const value = inactiveRepeatResolution(context.version, ref, kind, context.now)
    await this.effect(context, 'node.inactive', repeatSlotId(context.scope.runId, ref), value,
      [{ type: 'repeat.node.resolved', resolution: value, outside: ref.occurrence === null }], () => this.putResolution(context, value))
    return value
  }

  /** Queue/input admission is not dispatch. Capacity must be acquired by the
   * existing node driver BEFORE this SQL-only claim; no resource may be allocated
   * until the returned claim commits and its one-use permit is consumed. */
  async claimLaunch(executionId: string, paths: RepeatLaunchPaths): Promise<HarnessExecution | undefined> {
    const execution = await this.transaction(async (context) => {
      this.active(context)
      const native = requireRepeatNativeHooks(context.hooks.native)
      const stored = await this.execution(context, executionId)
      await assertHierarchyDirectionReleasedLocked(context.sql, context.scope.runId, executionId)
      await this.recordedEffect(context, 'input.bind', executionId)
      const claimed = await repeatQueries.readLaunchEffect(context.sql, context.scope.runId, executionId)
      if (claimed.rows[0]) {
        const claim = repeatLaunchClaim(context.scope, stored.ref, stored.execution, stored.inputDigest)
        const digest = repeatDigest(claim)
        if (claimed.rows[0].effect_digest !== digest) return repeatConflict('REPEAT_LAUNCH_IDENTITY_CONFLICT')
        await native.assertLaunchReceiptLocked(context.sql, claim, digest)
        return undefined // a receipt, even from our owner, NEVER recreates a permit
      }
      const reservation = await readWorkflowNativeEntryLocked(context.sql,
        workflowNativeReservation(context.scope, stored.ref, stored.execution, stored.inputDigest))
      if (reservation.phase !== 'reserved' || reservation.transition !== null
        || await repeatPossibleSubmissionLocked(context.sql, stored.execution)) return repeatConflict('NATIVE_SESSION_START_UNCERTAIN')
      await context.hooks.assertAuthorityLocked(context.sql)
      await native.assertLaunchLocked(context.sql, stored.execution, stored.ref, paths)
      const systemPrompt = await readSystemPromptSetting(context.sql)
      let next = HarnessExecutionSchema.parse({
        ...stored.execution, ...paths, systemPrompt,
        ...(context.hooks.run.resultProtocol ? { resultProtocol: context.hooks.run.resultProtocol } : {}), state: 'starting', startedAt: context.now,
      })
      if (context.hooks.prepareMemoryLaunchLocked) next = await context.hooks.prepareMemoryLaunchLocked(context.sql, next)
      const sessionContinuation = await readWorkflowSessionContinuation(context.sql, next)
      if (sessionContinuation) next = HarnessExecutionSchema.parse({ ...next, sessionContinuation })
      const claim = repeatLaunchClaim(context.scope, stored.ref, next, stored.inputDigest)
      const digest = repeatDigest(claim)
      const change = this.nativeChange(context, stored, next, 'launch', claim,
        { kind: 'execution.launch', entityId: executionId, digest })
      await this.publishNative(context, change)
      await native.assertLaunchReceiptLocked(context.sql, claim, digest)
      return next
    })
    // ExclusiveGraphConnection rejects unknown COMMIT outcomes and poisons its
    // connection. Neither that exception nor a later receipt read issues a permit.
    this.owner.assertOwned()
    if (execution && !this.owner.oneShotConnection().unusable) this.launchPermits.add(executionId)
    return execution
  }

  /** This is the final known-COMMIT gate BEFORE mkdir, manager allocation,
   * credential preflight, create or attach. SQL readback cannot recreate it. */
  async beginNativeEntry(executionId: string): Promise<WorkflowNativeEntryPermit> {
    this.owner.assertOwned()
    if (!this.launchPermits.delete(executionId)) return repeatConflict('NATIVE_SESSION_START_UNCERTAIN')
    return this.nativeEntry(executionId)
  }

  async authorizeNativeSubmission(executionId: string, prepared: WorkflowNativeEntryPermit): Promise<WorkflowNativeEntryPermit> {
    return this.nativeEntry(executionId, prepared)
  }

  private async nativeEntry(executionId: string, prepared?: WorkflowNativeEntryPermit): Promise<WorkflowNativeEntryPermit> {
    let committedSql: SqlTransaction | undefined
    await this.transaction(async (context) => {
      this.active(context)
      const stored = await this.execution(context, executionId)
      await this.recordedEffect(context, 'input.bind', executionId)
      await this.launchReceipt(context, stored)
      await context.hooks.assertAdmissionLocked(context.sql, stored.execution, stored.ref)
      if (stored.execution.nativeSessionId || stored.execution.state !== 'starting') return repeatConflict('NATIVE_ENTRY_CONFLICT')
      const claim = repeatLaunchClaim(context.scope, stored.ref, stored.execution, stored.inputDigest)
      const entry: WorkflowNativeEntryRecord = {
        reservation: workflowNativeReservation(context.scope, stored.ref, stored.execution, stored.inputDigest),
        phase: prepared ? 'entered' : 'prepared', ownerId: context.fence.ownerId, ownerFence: context.fence.fence,
        launchDigest: repeatDigest(claim),
      }
      const change = this.nativeChange(context, stored, stored.execution, 'native_entry', entry)
      await this.publishNative(context, change, () => enterWorkflowNativeLocked(context.sql, this.owner, entry, {
        scope: context.scope, evidence: { sourceKind: 'execution', sourceId: change.sourceId, sourceRevision: change.sourceRevision },
        sourceDigest: change.sourceDigest, effect: null,
      }, prepared))
      committedSql = context.sql
    })
    if (!committedSql) return repeatConflict('NATIVE_ENTRY_CONFLICT')
    return releaseWorkflowNativeEntryPermit(committedSql, this.owner, executionId)
  }

  /** SQL admission checks are intentionally distinct from a captured native
   * source/lease. They cannot acknowledge submission, terminal state or closure. */
  async assertExecutionAdmission(executionId: string): Promise<void> {
    await this.transaction(async (context) => {
      this.active(context)
      const stored = await this.execution(context, executionId)
      await this.recordedEffect(context, 'input.bind', executionId)
      await assertHierarchyDirectionReleasedLocked(context.sql, context.scope.runId, executionId)
      await context.hooks.assertAdmissionLocked(context.sql, stored.execution, stored.ref)
    })
  }

  private nativeChange(context: Context, stored: StoredRepeatExecution, next: HarnessExecution,
    kind: RepeatNativeChange['kind'], source: unknown, effect: RepeatNativeChange['effect'] = null): RepeatNativeChange {
    const sourceDigest = repeatDigest(source, 8 * 1024 * 1024)
    return { kind, scope: context.scope, ref: stored.ref, previous: stored.execution, next,
      source, sourceDigest, sourceId: repeatId('repeat-native', context.scope.runId,
        stored.ref.occurrence?.occurrenceId ?? 'outside', next.id, kind, sourceDigest), sourceRevision: '1', effect }
  }
  private async publishNative(context: Context, change: RepeatNativeChange, additionalMutation?: () => Promise<void>): Promise<void> {
    const native = requireRepeatNativeHooks(context.hooks.native)
    let mutations = 0
    await native.publishLocked(context.sql, change, async () => {
      if (++mutations !== 1) return repeatConflict('REPEAT_PUBLICATION_CONFLICT')
      await additionalMutation?.()
      const updated = await repeatQueries.updateNativeExecution(context.sql,
        change.next.id, context.scope.runId, JSON.stringify(change.next), JSON.stringify(change.previous))
      if (updated.rowCount !== 1) return repeatConflict('REPEAT_TERMINAL_CONFLICT')
      await workflowNativeLifecycleLocked(context, change)
    })
    if (mutations !== 1) return repeatConflict('REPEAT_PUBLICATION_CONFLICT')
    await native.assertReceiptLocked(context.sql, change)
  }

  private async launchReceipt(context: Context, stored: StoredRepeatExecution): Promise<void> {
    const native = requireRepeatNativeHooks(context.hooks.native)
    const claim = repeatLaunchClaim(context.scope, stored.ref, stored.execution, stored.inputDigest)
    const digest = repeatDigest(claim)
    const row = await repeatQueries.readLaunchEffect(context.sql, context.scope.runId, stored.execution.id)
    if (row.rows[0]?.effect_digest !== digest) return repeatConflict('REPEAT_LAUNCH_IDENTITY_CONFLICT')
    await native.assertLaunchReceiptLocked(context.sql, claim, digest)
  }

  private async assertSession(context: Context, execution: HarnessExecution,
    session: ReturnType<typeof NativeSessionReferenceSchema.parse>): Promise<void> {
    if (!execution.nativeSessionId || session.nativeSessionId !== execution.nativeSessionId
      || execution.runId !== context.scope.runId
      || context.version.agentConfigurationVersionIds[execution.agentId] !== execution.agentConfigurationVersionId) {
      return repeatConflict('NATIVE_SESSION_IDENTITY_MISMATCH')
    }
    const row = (await repeatQueries.readSessionConfiguration(context.sql,
      execution.id, execution.agentConfigurationVersionId, execution.agentId, context.scope.workspaceId)).rows[0]
    if (!row || !sameRepeatValue(NativeSessionReferenceSchema.parse(row.reference), session)
      || AgentConfigurationVersionSchema.parse(row.record).harness.harness !== session.harness) {
      return repeatConflict('NATIVE_SESSION_IDENTITY_MISMATCH')
    }
  }

  /** Recovery reads the original atomic session binding. A partial row can
   * never repair an execution or reconstruct a dispatch permit. */
  async recoverSession(executionId: string): Promise<HarnessExecution> {
    return this.transaction(async (context) => {
      this.active(context)
      const stored = await this.execution(context, executionId)
      await this.recordedEffect(context, 'input.bind', executionId)
      if (stored.execution.state === 'completed') return stored.execution
      await context.hooks.assertAuthorityLocked(context.sql)
      await this.launchReceipt(context, stored)
      if (stored.execution.nativeSessionId) {
        const native = (await repeatQueries.readNativeSession(context.sql, executionId)).rows[0]
        if (!native) return repeatConflict('NATIVE_SESSION_IDENTITY_MISMATCH')
        await this.assertSession(context, stored.execution, NativeSessionReferenceSchema.parse(native.reference))
      } else if (stored.workActivationId) {
        await markWorkNoticeUnknownLocked(context, stored.workActivationId, executionId)
      }
      // No session means possibly dispatched; the runtime never submits again.
      return stored.execution
    })
  }

  async exactSession(executionId: string): Promise<ReturnType<typeof NativeSessionReferenceSchema.parse>> {
    return this.transaction(async (context) => {
      this.active(context)
      const stored = await this.execution(context, executionId)
      await this.recordedEffect(context, 'input.bind', executionId)
      await this.launchReceipt(context, stored)
      await context.hooks.assertAuthorityLocked(context.sql)
      if (!stored.execution.nativeSessionId || stored.execution.state === 'completed') return repeatConflict('NATIVE_SESSION_START_UNCERTAIN')
      const rows = await repeatQueries.readNativeSession(context.sql, executionId)
      const session = NativeSessionReferenceSchema.parse(rows.rows[0]?.reference)
      await this.assertSession(context, stored.execution, session)
      return session
    })
  }

  /** Recheck before EVERY allocation/preflight/create/attach/turn boundary of
   * EVERY technical attempt. An in-flight call at Stop remains possible work.
   * This is not a replacement for the existing native manager's writer lease. */
  async assertNativeBoundary(executionId: string, evidence: RepeatNativeBoundaryEvidence): Promise<void> {
    await this.transaction(async (context) => {
      this.active(context)
      const native = requireRepeatNativeHooks(context.hooks.native)
      const stored = await this.execution(context, executionId)
      await this.recordedEffect(context, 'input.bind', executionId)
      await this.launchReceipt(context, stored)
      await context.hooks.assertAuthorityLocked(context.sql)
      if (stored.execution.state === 'completed') return repeatConflict('GRAPH_TERMINAL_CONFLICT')
      if (evidence.kind !== 'first_launch') {
        const rows = await repeatQueries.readNativeSession(context.sql, executionId)
        const session = NativeSessionReferenceSchema.parse(rows.rows[0]?.reference)
        if (!stored.execution.nativeSessionId || !sameRepeatValue(session, evidence.session)) return repeatConflict('NATIVE_SESSION_IDENTITY_MISMATCH')
        await this.assertSession(context, stored.execution, session)
      } else if (stored.execution.nativeSessionId) return repeatConflict('NATIVE_SESSION_START_UNCERTAIN')
      await native.assertBoundaryLocked(context.sql, stored.execution, stored.ref, evidence)
    })
  }

  async readWorkResultRepairAttempt(executionId: string): Promise<number> {
    return this.transaction(async context => {
      await this.execution(context, executionId)
      return readWorkResultRepairAttempt(context.sql, executionId)
    }, { readOnly: true })
  }

  async validateMemoryResult(executionId: string, result: ExecutionResult): Promise<void> {
    try {
      await this.transaction(async context => {
        const stored = await this.execution(context, executionId)
        if (!stored.execution.resultProtocol || result.outcome !== 'succeeded') return
        this.active(context)
        await context.hooks.assertAuthorityLocked(context.sql)
        if (!context.hooks.validateMemoryResultLocked) return repeatConflict('MEMORY_BOARDS_UNAVAILABLE')
        await context.hooks.validateMemoryResultLocked(context.sql, stored.execution, result)
        // Use the normal rollback boundary: validation never commits effects or notifications.
        throw new MemoryValidationComplete()
      })
    } catch (error) {
      if (!(error instanceof MemoryValidationComplete)) throw error
    }
  }

  async reserveWorkResultRepair(executionId: string, providerId: string,
    evidence: RepeatNativeEvidence): Promise<number | undefined> {
    return this.transaction(async (context) => {
      this.active(context)
      const stored = await this.execution(context, executionId)
      const control = await readWorkflowControlDispositionLocked(context.sql, context.scope.runId, executionId)
      if (control.kind !== 'ordinary') return undefined
      // Only historical interval checks lack a structured result contract.
      if (repeatTickIndex(stored.execution.input) !== undefined && !context.hooks.run.resultProtocol
        || stored.execution.state === 'completed') return repeatConflict('WORK_RESULT_REPAIR_CONFLICT')
      await this.recordedEffect(context, 'input.bind', executionId)
      await this.launchReceipt(context, stored)
      await context.hooks.assertAuthorityLocked(context.sql)
      await context.hooks.assertAdmissionLocked(context.sql, stored.execution, stored.ref)
      await requireRepeatNativeHooks(context.hooks.native).assertBoundaryLocked(
        context.sql, stored.execution, stored.ref, evidence)
      const attempts = (await repeatQueries.readRepairAttempts(context.sql, executionId)).rows
      // Reserve before submission: an uncertain offer is never replayed after recovery.
      if (attempts.length >= 2 || attempts.some(row => row.rejected_provider_id === providerId)) return undefined
      await repeatQueries.insertRepairAttempt(context.sql, executionId, attempts.length + 1, providerId)
      return attempts.length + 1
    })
  }

  /** The first durable native writer, shared by live and exact-history recovery.
   * NATIVE-2 supplies its original raw event/command/lease evidence to the required
   * guard. Preparation runs against the CURRENT LOCKED execution before any state
   * or public fact is written. An existing terminal is never normalized again. */
  async updateExecution(input: HarnessExecution, suppliedEvidence?: RepeatNativeEvidence,
    resultEffectFailure?: WorkflowResultEffectFailure): Promise<void> {
    const incoming = HarnessExecutionSchema.parse(structuredClone(input))
    const evidence = suppliedEvidence === undefined ? undefined : captureRepeatNativeEvidence(suppliedEvidence)
    await this.transaction(async (context) => {
      const native = requireRepeatNativeHooks(context.hooks.native)
      const stored = await this.execution(context, incoming.id)
      await this.recordedEffect(context, 'input.bind', incoming.id)
      // Pure equality on a terminal permits SQL-only immutable replay after Stop;
      // contradictory input is rejected BEFORE any normalizer or native callback.
      if (stored.execution.state === 'completed') {
        prepareRepeatNativeUpdate(context.version, context.scope, stored.ref, stored.execution, incoming)
        return
      }
      this.active(context)
      if (!evidence) return repeatConflict('REPEAT_NATIVE_EVIDENCE_REQUIRED')
      // Pure validation/normalization precedes even the authority adapter, which
      // may persist original native sources on this transaction.
      const workResultRepair = usesWorkHandoffGraph(context.version) && incoming.result?.outcome === 'failed'
        ? await readWorkResultRepairAttempt(context.sql, incoming.id) > 0 : false
      const deliverableFailure = await workflowDeliverableFailure(context.sql, context.version, incoming,
        context.hooks.run.resultProtocol)
      const effectFailure = await readWorkflowResultEffectFailureLocked(context.sql, context.version, incoming,
        context.hooks.run.resultProtocol, resultEffectFailure)
      const executionContext = usesWorkHandoffGraph(context.version) && stored.workActivationId
        && incoming.result?.outcome === 'succeeded'
        ? await readWorkResultContextLocked(context, stored.workActivationId, stored.execution.input,
          context.hooks.run.resultProtocol) : undefined
      const next = prepareRepeatNativeUpdate(context.version, context.scope, stored.ref, stored.execution, incoming,
        { workResultRepair, deliverableFailure, executionContext, resultProtocol: context.hooks.run.resultProtocol,
          resultEffectFailure: effectFailure })
      await this.launchReceipt(context, stored)
      await context.hooks.assertAuthorityLocked(context.sql)
      const original = await withNativeGraphProjectionBatch(context.sql, context.scope.runId,
        () => native.assertUpdateLocked(context.sql, structuredClone(stored.execution), structuredClone(incoming),
          structuredClone(stored.ref), evidence, resultEffectFailure))
      const rows = await repeatQueries.readNativeSession(context.sql, incoming.id)
      const session = NativeSessionReferenceSchema.parse(rows.rows[0]?.reference)
      if (!incoming.nativeSessionId || incoming.nativeSessionId !== session.nativeSessionId
        || !sameRepeatValue(session, evidence.session)) return repeatConflict('NATIVE_SESSION_IDENTITY_MISMATCH')
      await this.assertSession(context, incoming, session)
      if (incoming.state === 'completed') await assertApprovalTerminalSettlement(context.sql, context.scope.runId, incoming.id)
      if (sameRepeatValue(stored.execution, next)) return
      const change = this.nativeChange(context, stored, next, 'observation', {
        scope: context.scope, ref: stored.ref, previous: stored.execution, incoming, next,
        // Only a digest enters source receipts; the canonical adapter MUST retain
        // the actual raw provider source via existing native-event storage.
        native: original,
      })
      await this.publishNative(context, change, context.hooks.run.resultProtocol && next.state === 'completed'
        ? () => recordWorkflowCoordinationTerminalLocked(context.sql, change, original) : undefined)
      if (next.state === 'completed' && next.result?.outcome === 'succeeded'
        && context.version.approval.handler === 'orchestrator'
        && context.version.approval.designatedOrchestratorAgentId === next.agentId) {
        await finalizeRetainedRemoteReviewerLocked(context.sql, next)
      }
    })
  }

  /** The existing owner may close a nonterminal attempt only from a committed
   * pre-submission seal or the captured manager's exact durable close. This does
   * not reinterpret a missing session as no submission or alter an accepted
   * result. Pending closure remains pending across Stop and restart. */
  async settleNegativeExecution(executionId: string, canceled: boolean): Promise<void> {
    await this.transaction(async (context) => {
      const stored = await this.execution(context, executionId)
      await this.recordedEffect(context, 'input.bind', executionId)
      if (stored.execution.state === 'completed') return
      const closing = await repeatQueries.readClosingRun(context.sql, context.scope.runId, executionId)
      if (closing.rowCount !== 1 || canceled !== context.stopped) return repeatConflict('GRAPH_STOP_CONFLICT')
      const reservation = workflowNativeReservation(context.scope, stored.ref, stored.execution, stored.inputDigest)
      const entry = await readWorkflowNativeEntryLocked(context.sql, reservation)
      let seal: WorkflowNativeEntryRecord | undefined
      let closure: Awaited<ReturnType<typeof readWorkflowClosure>> | Awaited<ReturnType<typeof readUnboundWorkflowClosure>>
      if (entry.phase === 'reserved' || entry.phase === 'prepared') {
        if (stored.execution.nativeSessionId) return repeatConflict('NATIVE_ENTRY_CONFLICT')
        seal = { reservation, phase: 'not_submitted', ownerId: context.fence.ownerId,
          ownerFence: context.fence.fence, launchDigest: entry.transition?.launchDigest ?? null }
      } else if (entry.phase === 'entered') {
        closure = await (stored.execution.nativeSessionId ? readWorkflowClosure : readUnboundWorkflowClosure)(context.sql, stored.execution)
        if (!closure?.durableGeneration) return repeatConflict('REPEAT_CLEANUP_PENDING')
        const generation = closure.durableGeneration
        beforeGraphCommit(context.sql, async () => {
          const current = await (stored.execution.nativeSessionId ? readWorkflowClosure : readUnboundWorkflowClosure)(context.sql, stored.execution)
          if (!current || current.durableGeneration !== generation || !sameRepeatValue(current, closure)) {
            return repeatConflict('REPEAT_NATIVE_IDENTITY_CONFLICT')
          }
        })
      } else return repeatConflict('NATIVE_ENTRY_CONFLICT')
      const budget = (await repeatQueries.readExecutionFailure(context.sql, executionId)).rows[0]
      const failure = budget?.failure_result ? ExecutionResultSchema.parse(budget.failure_result) : undefined
      if (failure && failure.outcome !== 'failed') return repeatConflict('RUN_FAILURE_CAUSE_INVALID')
      const cleanup = (await repeatQueries.readCleanupFailure(context.sql, context.scope.runId)).rows[0]
      const runFailure = cleanup?.failure_result ? ExecutionResultSchema.parse(cleanup.failure_result) : undefined
      if (runFailure && runFailure.outcome !== 'failed') return repeatConflict('RUN_FAILURE_CAUSE_INVALID')
      const siblingResult = runFailure ? { outcome: 'canceled' as const } : { outcome: 'failed' as const,
        error: { code: 'EXECUTION_INTERRUPTED', message: 'The native attempt was closed without an accepted result.', retryable: false } }
      const result = canceled ? { outcome: 'canceled' as const } : failure ?? siblingResult
      const next = HarnessExecutionSchema.parse({ ...stored.execution, state: 'completed', result, finishedAt: context.now })
      const source = { scope: context.scope, ref: stored.ref, previous: stored.execution, next,
        ...(seal ? { noSubmission: seal } : { closure }) }
      const change = this.nativeChange(context, stored, next, 'negative_settlement', source)
      await this.publishNative(context, change, async () => {
        if (seal) await sealWorkflowNativeEntryLocked(context.sql, this.owner, seal, {
          scope: context.scope, evidence: { sourceKind: 'execution', sourceId: change.sourceId, sourceRevision: '1' },
          sourceDigest: change.sourceDigest, effect: null,
        })
        // An attempt closed for its own recorded cause shows that cause in Run activity.
        if (!canceled && failure) await repeatQueries.insertResultActivity(context.sql,
          context.scope.runId, executionId, context.now,
          canonicalGraphJson({ workflowNodeId: stored.ref.nodeId, result }))
      })
    })
  }

  async failPreparation(executionId: string, failure: unknown): Promise<void> {
    const result = ExecutionResultSchema.parse(failure)
    if (result.outcome !== 'failed' || !result.error || result.error.retryable) {
      return repeatConflict('RUN_FAILURE_CAUSE_INVALID')
    }
    await this.transaction(async context => {
      const stored = await this.execution(context, executionId)
      await this.recordedEffect(context, 'input.bind', executionId)
      if (stored.execution.state === 'completed') return
      this.active(context)
      if (await repeatPossibleSubmissionLocked(context.sql, stored.execution)) {
        return repeatConflict('NATIVE_ENTRY_CONFLICT')
      }
      const reservation = workflowNativeReservation(context.scope, stored.ref, stored.execution, stored.inputDigest)
      const entry = await readWorkflowNativeEntryLocked(context.sql, reservation)
      if (entry.phase !== 'reserved') return repeatConflict('NATIVE_ENTRY_CONFLICT')
      const seal: WorkflowNativeEntryRecord = { reservation, phase: 'not_submitted',
        ownerId: context.fence.ownerId, ownerFence: context.fence.fence, launchDigest: null }
      const next = HarnessExecutionSchema.parse({ ...stored.execution,
        state: 'completed', result, finishedAt: context.now })
      const change = this.nativeChange(context, stored, next, 'negative_settlement', {
        scope: context.scope, ref: stored.ref, previous: stored.execution, next, noSubmission: seal,
      })
      await this.publishNative(context, change, async () => {
        await sealWorkflowPreparationFailureLocked(context.sql, this.owner, seal, {
          scope: context.scope, evidence: { sourceKind: 'execution', sourceId: change.sourceId, sourceRevision: '1' },
          sourceDigest: change.sourceDigest, effect: null,
        })
        const continuation = (await repeatQueries.readAdmittedControlContinuation(context.sql, context.scope.runId, executionId)).rows[0]
        if (continuation) await failWorkflowControlContinuationLocked(context.sql, {
          runId: context.scope.runId, continuationId: continuation.id,
          errorCode: result.error!.code, now: context.now,
        })
        await closeWorkflowControlInputLocked(context.sql, { runId: context.scope.runId, executionId, now: context.now })
        await repeatQueries.insertResultActivity(context.sql,
          context.scope.runId, executionId, context.now,
          canonicalGraphJson({ workflowNodeId: stored.ref.nodeId, result }))
      })
    })
  }

  /** SQL-only close/finalization repair. The native coordinator has already
   * supplied exact durable close/credential/approval evidence. This method never
   * calls finishRun and does not activate a successor or rewrite an execution.
   * It remains usable during Stop cleanup under the same owner. */
  async settleNativeExecution(executionId: string): Promise<void> {
    await this.transaction(async (context) => { await this.settlement(context, [executionId]) })
  }
  private async settlement(context: Context, executionIds: readonly string[]): Promise<void> {
    const ids = [...new Set(executionIds)].sort()
    for (const executionId of ids) {
      const stored = await this.execution(context, executionId)
      await this.recordedEffect(context, 'input.bind', executionId)
      await settleRepeatNativeExecutionLocked(context.sql, context.scope.runId, stored.execution)
    }
    // Preserve host-specific native, authorization and publication fences in
    // addition to the mandatory concrete per-execution settlement proof above.
    await context.hooks.assertSettlementLocked(context.sql, ids)
  }
  private async settleAttempts(context: Context, selected: RepeatNativeAttemptSelection): Promise<void> {
    await visitRepeatNativeAttemptsLocked(context.sql, context.scope.runId, selected,
      (ids) => this.settlement(context, ids))
  }

  async readOccurrence(occurrenceId: string): Promise<RepeatOccurrenceV1> {
    return this.transaction(async (context) => (await this.occurrence(context, occurrenceId)).occurrence, { readOnly: true })
  }
  async readExecution(executionId: string): Promise<StoredRepeatExecution> {
    return this.transaction(async (context) => {
      const stored = await this.execution(context, executionId)
      await this.recordedEffect(context, 'input.bind', executionId)
      return stored
    }, { readOnly: true })
  }
  async enterBlock(blockId: string): Promise<{ kind: 'inactive' } | { kind: 'active'; occurrence: RepeatOccurrenceV1 }> {
    return this.transaction(async (context) => {
      this.active(context)
      const block = repeatBlock(context.version, blockId)
      const heads = await repeatQueries.readLatestOccurrence(context.sql, context.scope.runId, blockId)
      if (heads.rows[0]) {
        const value = (await this.occurrence(context, heads.rows[0].occurrence_id)).occurrence
        await this.occurrenceReceipt(context, value)
        return { kind: 'active', occurrence: value }
      }
      const outside = await this.resolutions(context, null)
      if (outside.has(block.exitNodeId)) {
        if (!['skipped', 'excluded'].includes(outside.get(block.exitNodeId)!.value.resolution)) return repeatConflict('REPEAT_EXPORT_CONFLICT')
        return { kind: 'inactive' }
      }
      const admission = decideRepeatBlockEntry(context.version, block, outside)
      if (admission.kind === 'waiting' || admission.kind === 'resolved') return repeatConflict('REPEAT_ENTRY_UNRESOLVED')
      if (admission.kind === 'skipped' || admission.kind === 'excluded') {
        await this.inactive(context, { nodeId: block.exitNodeId, occurrence: null }, admission.kind)
        return { kind: 'inactive' }
      }
      if (admission.kind !== 'run') return repeatConflict('REPEAT_ENTRY_UNRESOLVED')
      const external: RepeatSource[] = []
      for (const edge of admission.selected) external.push(await this.acceptedSource(context, outside.get(edge.source)!, edge.id))
      const value = makeRepeatOccurrence(context.scope, block, freezeRepeatEntry(context.hooks.run.input, external), null)
      await this.effect(context, 'occurrence.create', value.occurrence.identity.occurrenceId, value,
        [{ type: 'repeat.occurrence', occurrence: value.occurrence }], () => this.putOccurrence(context, value))
      return { kind: 'active', occurrence: value.occurrence }
    })
  }

  async admit(ref: RepeatNodeRef, candidate: () => HarnessExecution): Promise<RepeatAdmission> {
    return this.transaction(async (context) => {
      this.active(context)
      assertRepeatRef(context.version, context.scope, ref)
      const occurrence = ref.occurrence ? await this.occurrence(context, ref.occurrence.occurrenceId) : null
      if (occurrence) await this.occurrenceReceipt(context, occurrence.occurrence)
      if (!sameRepeatValue(ref.occurrence, occurrence?.occurrence.identity ?? null)) return repeatConflict('REPEAT_OCCURRENCE_CONFLICT')
      const resolutions = await this.resolutions(context, ref.occurrence?.occurrenceId ?? null)
      const admission = decideRepeatAdmission(context.version, ref, resolutions)
      if (admission.kind === 'resolved') {
        const resolution = resolutions.get(ref.nodeId)!
        await this.recordedEffect(context, resolution.value.execution ? 'terminal.accept' : 'node.inactive',
          resolution.value.execution?.executionId ?? repeatSlotId(context.scope.runId, ref))
        return { kind: 'resolved', resolution }
      }
      if (admission.kind === 'waiting') return { kind: 'waiting' }
      if (admission.kind === 'skipped' || admission.kind === 'excluded') return { kind: 'resolved', resolution: await this.inactive(context, ref, admission.kind) }
      if (admission.kind !== 'run') return repeatConflict('REPEAT_ENTRY_UNRESOLVED')
      const slotId = repeatSlotId(context.scope.runId, ref)
      const existing = await repeatQueries.readLatestSlotExecution(context.sql, slotId)
      if (existing.rows[0]) {
        await this.recordedEffect(context, 'input.bind', existing.rows[0].execution_id)
        return { kind: 'admitted', execution: (await this.execution(context, existing.rows[0].execution_id)).execution, reused: true }
      }
      if (occurrence) {
        const decided = await repeatQueries.readDecisionExists(context.sql, occurrence.occurrence.identity.occurrenceId)
        if (decided.rowCount) return repeatConflict('REPEAT_OCCURRENCE_CLOSED')
      }
      if (occurrence?.occurrence.input.previous
        && repeatBlock(context.version, occurrence.occurrence.identity.blockId).entryNodeId === ref.nodeId) {
        await this.settleAttempts(context, { kind: 'occurrence', id: occurrence.occurrence.input.previous.occurrenceId })
      }
      const execution = HarnessExecutionSchema.parse(candidate())
      this.assertCandidate(context, ref, execution, 1)
      const sources: RepeatSource[] = []
      for (const edge of admission.selected) sources.push(await this.acceptedSource(context, resolutions.get(edge.source)!, edge.id))
      const bound = bindRepeatNodeInput({ version: context.version, runInput: occurrence?.input.runInput ?? context.hooks.run.input,
        recipient: execution, ref, occurrence: occurrence?.occurrence ?? null, entry: occurrence?.input ?? null, predecessors: sources })
      const queued = HarnessExecutionSchema.parse({ ...execution, input: bound.input })
      await context.hooks.assertAdmissionLocked(context.sql, queued, ref)
      await assertWorkflowExecutionCapacityLocked(context.sql, context.scope.runId, context.version)
      await this.effect(context, 'input.bind', queued.id, { ref, queued, inputDigest: bound.digest, bindings: bound.bindings },
        [{ type: 'repeat.execution.queued', ref, execution: repeatExecutionIdentity(queued), inputDigest: bound.digest }], async () => {
          await repeatQueries.insertSlot(context.sql, {
            slotId, runId: context.scope.runId, occurrenceId: ref.occurrence?.occurrenceId ?? null, nodeId: ref.nodeId,
            inputJson: canonicalGraphJson(bound.input, 4 * 1024 * 1024), inputDigest: bound.digest
          })
          await this.insertExecution(context, ref, queued, slotId, bound.digest, bound.bindings, null)
        })
      return { kind: 'admitted', execution: queued, reused: false }
    })
  }
  /** Interval check admission for a node whose graph work is settled. A check is one more
   * execution of the node in its own slot: no input bindings, resolution, routing or budget use.
   * Until the caller has observed the node's latest check through settlement (settledId), busy
   * returns that check again, so neither a cleanup failure nor a restart leaves it behind. */
  async admitTick(nodeId: string, candidate: () => HarnessExecution, settledId: string | null): Promise<RepeatTickAdmission> {
    return this.transaction(async (context) => {
      this.active(context)
      if (context.hooks.run.executionState !== 'running') return { kind: 'wait', dueAt: null }
      const node = context.version.definition.nodes.find((item) => item.id === nodeId)
      if (!node || node.kind === 'job' || !node.interval || blockForNode(context.version, nodeId)) return repeatConflict('TICK_NODE_CONFLICT')
      const facts = await readIntervalCheckFacts(context.sql, context.scope.runId, nodeId, usesWorkHandoffGraph(context.version))
      if (facts.lastTickId && facts.lastTickId !== settledId) {
        await this.recordedEffect(context, 'input.bind', facts.lastTickId)
        return { kind: 'busy', execution: (await this.execution(context, facts.lastTickId)).execution }
      }
      if (facts.openId) return { kind: 'busy' }
      const dueAt = nextIntervalCheckAt(facts, node.interval.everySeconds)
      if (!dueAt || dueAt > context.now) return { kind: 'wait', dueAt }
      const ref: RepeatNodeRef = { nodeId, occurrence: null }
      const execution = HarnessExecutionSchema.parse(candidate())
      this.assertCandidate(context, ref, execution, 1)
      const tickIndex = facts.lastTick + 1
      const input = IntervalCheckAcceptedInputSchema.parse({
        executionSemanticsVersion: 3, runInput: context.hooks.run.input, occurrence: null, entry: null,
        predecessors: [], tick: { index: tickIndex, everySeconds: node.interval.everySeconds },
      })
      const queued = HarnessExecutionSchema.parse({ ...execution, input })
      const inputDigest = repeatDigest(input, 4 * 1024 * 1024), slotId = tickSlotId(context.scope.runId, nodeId, tickIndex)
      await context.hooks.assertAdmissionLocked(context.sql, queued, ref)
      await this.effect(context, 'input.bind', queued.id, { ref, queued, inputDigest, bindings: [], tickIndex },
        [{ type: 'repeat.execution.queued', ref, execution: repeatExecutionIdentity(queued), inputDigest }], async () => {
          await repeatQueries.insertTickSlot(context.sql, {
            slotId, runId: context.scope.runId, nodeId, inputJson: canonicalGraphJson(input, 4 * 1024 * 1024),
            inputDigest, tickIndex
          })
          await this.insertExecution(context, ref, queued, slotId, inputDigest, [], null)
        })
      return { kind: 'admitted', execution: queued }
    })
  }
  private assertCandidate(context: Context, ref: RepeatNodeRef, candidate: HarnessExecution, attempt: number): void {
    assertRepeatExecution(context.version, context.scope, ref, candidate)
    if (candidate.attempt !== attempt || candidate.state !== 'queued' || candidate.result !== undefined || candidate.nativeSessionId !== undefined
      || candidate.sessionContinuation !== undefined
      || candidate.runtimeDirectory !== undefined || candidate.workingDirectory !== undefined || candidate.startedAt !== undefined
      || candidate.finishedAt !== undefined) repeatConflict('EXECUTION_ADMISSION_INVALID')
  }
  private async insertExecution(context: Context, ref: RepeatNodeRef, execution: HarnessExecution, slotId: string,
    inputDigest: string, bindings: RepeatInputBinding[], previousExecutionId: string | null,
    workActivationId: string | null = null, controlContinuation?: WorkflowControlContinuation): Promise<void> {
    const tickIndex = repeatTickIndex(execution.input) ?? null
    if (tickIndex === null) {
      await assertWorkflowExecutionCapacityLocked(context.sql, context.scope.runId, context.version, workActivationId,
        1, controlContinuation?.id ?? null)
    }
    const occurrenceId = ref.occurrence?.occurrenceId ?? null
    const identity = ref.occurrence ? { ...repeatExecutionIdentity(execution), occurrence: ref.occurrence } : repeatExecutionIdentity(execution)
    if (workActivationId) {
      await repeatQueries.insertWorkHarnessExecution(context.sql, {
        executionId: execution.id, runId: context.scope.runId, nodeId: ref.nodeId, agentId: execution.agentId,
        attempt: execution.attempt, occurrenceId, activationId: workActivationId, record: JSON.stringify(execution)
      })
      await repeatQueries.insertWorkRepeatExecution(context.sql, {
        executionId: execution.id, runId: context.scope.runId, slotId, occurrenceId, activationId: workActivationId,
        attempt: execution.attempt, previousExecutionId, identity: JSON.stringify(identity)
      })
    } else {
      // Only checks write tick_index; ordinary work keeps the statement every schema accepts.
      await repeatQueries.insertHarnessExecution(context.sql, {
        executionId: execution.id, runId: context.scope.runId, nodeId: ref.nodeId, agentId: execution.agentId,
        attempt: execution.attempt, occurrenceId, record: JSON.stringify(execution)
      }, tickIndex)
      await repeatQueries.insertRepeatExecution(context.sql, {
        executionId: execution.id, runId: context.scope.runId, slotId, occurrenceId, attempt: execution.attempt,
        previousExecutionId, identity: JSON.stringify(identity)
      })
    }
    await reserveWorkflowNativeEntryLocked(context.sql, workflowNativeReservation(context.scope, ref, execution, inputDigest))
    await context.hooks.persistDispatchLocked?.(context.sql, execution, ref, inputDigest)
    for (const binding of bindings) await repeatQueries.insertBinding(context.sql, {
      bindingId: binding.bindingId, runId: context.scope.runId, executionId: execution.id,
      sourceExecutionId: binding.source.execution.executionId, sourceResultDigest: binding.source.acceptedResultDigest,
      inputDigest, slotId, ordinal: binding.ordinal, record: JSON.stringify(binding)
    })
    if (controlContinuation) await completeWorkflowControlContinuationLocked(context.sql, {
      runId: execution.runId, continuationId: controlContinuation.id, now: context.now,
      successorExecution: { runId: execution.runId, workflowVersionId: context.version.id,
        executionId: execution.id, attempt: execution.attempt, ...(workActivationId ? { activationId: workActivationId } : {}) },
    })
    await workflowAdmissionLifecycleLocked(context, execution, previousExecutionId, controlContinuation)
  }

  /** Acceptance + local route + decision + successor intent/final export share ONE
   * SQL/publication transaction. The graph's later boundary only reads this result. */
  async acceptTerminal(executionId: string, candidate?: (attempt: number) => HarnessExecution,
    expectedExecution?: HarnessExecution): Promise<RepeatAcceptance> {
    const expected = expectedExecution === undefined ? undefined : HarnessExecutionSchema.parse(structuredClone(expectedExecution))
    return this.transaction<RepeatAcceptance | { kind: 'control_failed'; result: ExecutionResult }>(async (context) => {
      const stored = await this.execution(context, executionId), { execution, ref } = stored
      if (expected && !sameRepeatValue(expected, execution)) return repeatConflict('REPEAT_TERMINAL_CONFLICT')
      await this.recordedEffect(context, 'input.bind', executionId)
      const controlled = await this.continueControlledExecution(context, stored)
      if (controlled) return controlled
      const resolutions = await this.resolutions(context, ref.occurrence?.occurrenceId ?? null)
      const previous = resolutions.get(ref.nodeId)
      if (previous) {
        if (!sameRepeatValue(previous, repeatTerminalResolution(context.version, context.scope, ref, execution,
          context.hooks.run.resultProtocol))) return repeatConflict('REPEAT_TERMINAL_CONFLICT')
        if (previous.value.execution?.executionId !== executionId) return repeatConflict('REPEAT_TERMINAL_CONFLICT')
        if (previous.value.acceptedResultDigest && previous.value.acceptedResultDigest !== repeatDigest(execution.result, 64 * 1024)) return repeatConflict('REPEAT_TERMINAL_CONFLICT')
        await this.recordedEffect(context, 'terminal.accept', executionId)
        await this.assertArtifactOutputs(context, execution)
        return { kind: 'resolved', resolution: previous }
      }
      this.active(context)
      await this.settleAttempts(context, { kind: 'slot', id: stored.slotId, throughAttempt: execution.attempt })
      const next = await repeatQueries.readSuccessorExecution(context.sql, executionId)
      if (next.rows[0]) {
        await this.recordedEffect(context, 'input.bind', next.rows[0].execution_id)
        return { kind: 'retry', execution: (await this.execution(context, next.rows[0].execution_id)).execution }
      }
      // Do not repair a previously written invalid success by overwriting it here.
      const resolution = repeatTerminalResolution(context.version, context.scope, ref, execution, context.hooks.run.resultProtocol)
      await this.assertArtifactOutputs(context, execution)
      if (execution.result?.outcome === 'failed' && execution.result.error?.retryable
        && await context.hooks.allowTechnicalRetryLocked(context.sql, execution)) {
        if (stored.accepted || execution.attempt >= 2147483647) return repeatConflict('REPEAT_RETRY_NOT_ALLOWED')
        if (!candidate) return repeatConflict('REPEAT_RETRY_CANDIDATE_REQUIRED')
        const replacement = HarnessExecutionSchema.parse(candidate(execution.attempt + 1))
        this.assertCandidate(context, ref, replacement, execution.attempt + 1)
        const queued = HarnessExecutionSchema.parse({ ...replacement, input: stored.input })
        await context.hooks.assertAdmissionLocked(context.sql, queued, ref)
        const bound = await repeatQueries.readBindings(context.sql, executionId)
        const bindings = bound.rows.map((row) => {
          const value = BindingSchema.parse(row.record) as RepeatInputBinding
          if (!sameRepeatValue(value.recipient, repeatExecutionIdentity(execution))
            || !sameRepeatValue(value.recipientOccurrence, ref.occurrence) || value.inputDigest !== stored.inputDigest
            || repeatDigest(value.source.acceptedResult, 64 * 1024) !== value.source.acceptedResultDigest) return repeatConflict('REPEAT_BINDING_CONFLICT')
          return { ...value, bindingId: repeatId('repeat-binding', queued.id, value.kind, value.ordinal), recipient: repeatExecutionIdentity(queued) }
        })
        await this.effect(context, 'input.bind', queued.id, { previousExecutionId: executionId, queued, inputDigest: stored.inputDigest, bindings },
          [{ type: 'repeat.execution.queued', ref, execution: repeatExecutionIdentity(queued), inputDigest: stored.inputDigest }],
          () => this.insertExecution(context, ref, queued, stored.slotId, stored.inputDigest, bindings, executionId))
        return { kind: 'retry', execution: queued }
      }
      const block = ref.occurrence && blockForNode(context.version, ref.nodeId)
      let decision: RepeatDecisionV1 | undefined, successor: StoredOccurrence | undefined, exported: RepeatResolution | undefined
      if (block && block.exitNodeId === ref.nodeId && resolution.value.resolution === 'succeeded') {
        resolutions.set(ref.nodeId, resolution)
        assertRepeatBodyComplete(context.version, ref.occurrence!, resolutions)
        await this.settleAttempts(context, { kind: 'occurrence', id: ref.occurrence!.occurrenceId })
        const current = await this.occurrence(context, ref.occurrence!.occurrenceId)
        const exit = context.version.definition.nodes.find((node) => node.id === ref.nodeId)!
        decision = decideRepeatExit(context.version, current.occurrence, execution,
          parseRepeatExitResultV1(execution.result, exit.choice!, exit.kind === 'job' ? undefined : exit.artifactOutputs,
            context.hooks.run.resultProtocol && exit.kind !== 'job' ? { resultProtocol: context.hooks.run.resultProtocol,
              definition: context.version.definition, workflowNodeId: exit.id } : undefined), context.now)
        if (decision.reason === 'repeat') {
          successor = makeRepeatOccurrence(context.scope, block, repeatSuccessorInput(current.input, decision, execution.result!), decision)
        } else exported = finalRepeatExport(context.version, resolution, decision)
      }
      const facts: RepeatFact[] = [{ type: 'repeat.node.resolved', resolution, outside: ref.occurrence === null }]
      if (resolution.value.acceptedResultDigest) facts.unshift({ type: 'repeat.result.accepted', ref,
        execution: repeatExecutionIdentity(execution), resultDigest: resolution.value.acceptedResultDigest })
      if (decision) {
        const { resultData: _private, ...metadata } = decision
        void _private
        facts.push({ type: 'repeat.decision', decision: RepeatDecisionMetadataV1Schema.parse(metadata) })
      }
      if (successor) facts.push({ type: 'repeat.occurrence', occurrence: successor.occurrence })
      if (exported) facts.push({ type: 'repeat.node.resolved', resolution: exported, outside: true })
      await this.effect(context, 'terminal.accept', executionId, { execution, resolution, decision: decision ?? null,
        successor: successor ?? null, exported: exported ?? null }, facts, async () => {
        if (resolution.value.acceptedResultDigest) {
          await repeatQueries.insertRepeatResult(context.sql, {
            executionId, runId: context.scope.runId, occurrenceId: ref.occurrence?.occurrenceId ?? null,
            resultJson: canonicalGraphJson(execution.result, 64 * 1024),
            resultDigest: resolution.value.acceptedResultDigest, acceptedAt: context.now
          })
          await repeatQueries.acceptExecution(context.sql, executionId, context.scope.runId)
        }
        await this.putResolution(context, resolution)
        if (decision) await repeatQueries.insertDecision(context.sql, {
          decisionId: decision.decisionId, occurrenceId: decision.occurrence.identity.occurrenceId, executionId,
          resultDigest: decision.acceptedResultDigest, record: JSON.stringify(decision)
        })
        if (successor) await this.putOccurrence(context, successor)
        if (exported) await this.putResolution(context, exported, true)
        await closeWorkflowControlInputLocked(context.sql, { runId: context.scope.runId, executionId, now: context.now })
        if (execution.result?.outcome === 'succeeded') {
          const findings = decision?.resultData.remainingFindings ?? []
          await workflowLifecycleLocked(context, execution, findings.length ? 'blocked' : 'accepted',
            `workflow:${execution.id}:accepted`, findings.length ? { reason: 'Unresolved findings require further work.' } : {})
        }
      })
      if (decision) return { kind: 'resolved', resolution }
      return { kind: 'accepted', resolution }
    }).then(value => {
      if (value.kind === 'control_failed') throw new WorkExecutionFailure(value.result)
      return value
    }).catch(error => this.failControlAdmission(executionId, error))
  }

  async transition(occurrenceId: string): Promise<{ decision: RepeatDecisionV1; next: RepeatOccurrenceV1 | null }> {
    return this.transaction(async (context) => {
      this.active(context) // A recorded pre-Stop repeat decision cannot reactivate work.
      const current = await this.occurrence(context, occurrenceId)
      const rows = await repeatQueries.readDecision(context.sql, occurrenceId)
      if (!rows.rows[0]) return repeatConflict('REPEAT_DECISION_MISSING')
      const decision = RepeatDecisionV1Schema.parse(rows.rows[0].record)
      const execution = await this.execution(context, decision.exitExecution.executionId)
      if (!execution.accepted || repeatDigest(execution.execution.result, 64 * 1024) !== decision.acceptedResultDigest
        || !sameRepeatValue(current.occurrence, decision.occurrence)) return repeatConflict('REPEAT_TERMINAL_CONFLICT')
      validateRepeatDecisionV1(context.version, decision, execution.execution.result, context.hooks.run.resultProtocol)
      await this.recordedEffect(context, 'terminal.accept', execution.execution.id)
      if (decision.reason !== 'repeat') return { decision, next: null }
      const found = await repeatQueries.readOccurrenceAtIndex(context.sql,
        context.scope.runId, current.occurrence.identity.blockId, current.occurrence.identity.occurrenceIndex + 1)
      if (!found.rows[0]) return repeatConflict('REPEAT_SUCCESSOR_MISSING')
      const next = await this.occurrence(context, found.rows[0].occurrence_id)
      validateRepeatSuccessorV1(context.version, decision, next.occurrence, execution.execution.result, context.hooks.run.resultProtocol)
      if (!sameRepeatValue(next.input, repeatSuccessorInput(current.input, decision, execution.execution.result!))) return repeatConflict('REPEAT_CARRY_CONFLICT')
      const activated = await repeatQueries.readOccurrenceEntryExecution(context.sql,
        context.scope.runId, next.occurrence.identity.occurrenceId,
        repeatBlock(context.version, current.occurrence.identity.blockId).entryNodeId)
      if (!activated.rows[0]) await this.settleAttempts(context, { kind: 'occurrence', id: occurrenceId })
      else await this.recordedEffect(context, 'input.bind', activated.rows[0].execution_id)
      return { decision, next: next.occurrence }
    })
  }

  async resolveExcluded(): Promise<void> {
    const excluded = compileExecutionTopology(this.expectedVersion).excluded
    for (const nodeId of excluded) {
      const block = blockForNode(this.expectedVersion, nodeId)
      if (block && nodeId !== block.exitNodeId) continue
      await this.transaction(async (context) => {
        this.active(context)
        const existing = await this.resolutions(context, null)
        if (!existing.has(nodeId)) await this.inactive(context, { nodeId, occurrence: null }, 'excluded')
      })
    }
  }
  async completeRun(): Promise<void> {
    await this.transaction(async (context) => {
      const outside = await this.resolutions(context, null), topology = compileExecutionTopology(context.version)
      const required = topology.order.filter((nodeId) => {
        const block = blockForNode(context.version, nodeId)
        return !block || block.exitNodeId === nodeId
      })
      const terminals: RepeatSource[] = []
      for (const nodeId of required) {
        const row = outside.get(nodeId)
        if (!row || row.deferredRelationshipIds.length) return repeatConflict('REPEAT_SELECTED_WORK_UNRESOLVED')
        if (!['succeeded', 'skipped'].includes(row.value.resolution)) return repeatConflict('REPEAT_SELECTED_WORK_FAILED')
        if (row.value.resolution === 'succeeded' && row.value.selectedRelationshipIds.length === 0) terminals.push(await this.acceptedSource(context, row, 'terminal'))
      }
      // Recovery of our already committed success is read-only, not permission
      // to revive a stopped/failed Run or reissue its completion side effects.
      if (context.hooks.run.executionState === 'completed' && !context.stopped) {
        const effect: RepeatEffect = { kind: 'run.complete', entityId: context.scope.runId, digest: repeatDigest(terminals) }
        const prior = await repeatQueries.readEffect(context.sql, context.scope.runId, effect.kind, effect.entityId)
        if (prior.rows[0]?.payload_digest !== effect.digest) return repeatConflict('REPEAT_EFFECT_CONFLICT')
        await context.hooks.assertPublicationReceiptLocked(context.sql, effect)
        return
      }
      this.active(context)
      if (context.version.definition.nodes.some(node => node.kind !== 'job' && node.interval)) return
      // Required global approval/cleanup/pending transition checks belong to the
      // same existing terminal writer. A single final block is never Run completion.
      await this.settleAttempts(context, { kind: 'run' })
      await this.effect(context, 'run.complete', context.scope.runId, terminals, [],
        () => context.hooks.completeRunLocked(context.sql, terminals))
    })
  }
  async completeWorkRun(): Promise<'completed' | 'needs_direction' | 'idle'> {
    return this.transaction(async (context) => {
      if (!usesWorkHandoffGraph(context.version) || declaresRepeatBlocks(context.version)) return repeatConflict('WORK_POLICY_PIN_CONFLICT')
      if (isHierarchyWorkflow(context.version)) {
        const terminals = await hierarchyCompletionLocked({ ...context, assertActive: () => this.active(context) })
        if (context.hooks.run.executionState === 'completed' && !context.stopped) {
          await context.hooks.assertPublicationReceiptLocked(context.sql,
            { kind: 'run.complete', entityId: context.scope.runId, digest: repeatDigest(terminals) })
          return 'completed'
        }
        this.active(context)
        await this.settleAttempts(context, { kind: 'run' })
        await this.effect(context, 'run.complete', context.scope.runId, terminals, [],
          () => context.hooks.completeRunLocked(context.sql, terminals))
        return 'completed'
      }
      const activations = await readWorkActivationStates(context.sql, context.scope.runId)
      const failures = await this.workFailures(context)
      const failedActivations = new Set(failures.map(row => row.activationId))
      if (!activations.length || activations.some(row =>
        row.state !== 'completed' && !failedActivations.has(row.activation_id))) {
        return repeatConflict('WORK_ACTIVATIONS_UNRESOLVED')
      }
      const unreturned = await readUnreturnedWorkRequests(context.sql, context.scope.runId, [...failedActivations])
      // A destination that finished its chain answered the request; only a pending return is unresolved.
      if (unreturned.some(row => row.result_json === null || parseWorkflowWorkResult(
        AcceptedCurrentNodeResultSchema.parse(JSON.parse(row.result_json)), context.version,
        row.destination_node_id, context.hooks.run.resultProtocol).routing.kind !== 'finish')) {
        return repeatConflict('WORK_REQUEST_UNRESOLVED')
      }
      if (failures[0]) throw new WorkExecutionFailure(failures[0].result)
      const activationIds = new Set(activations.map((row) => row.activation_id))
      const denied = await readWorkDenialContinuations(context.sql, context.scope.runId)
      if (denied.some((row) => !row.notice_id || row.delivery_state !== 'delivered'
        || !row.continuation_activation_id || row.activation_state !== 'completed' || !row.accepted)) {
        return repeatConflict('WORK_DENIAL_CONTINUATION_UNRESOLVED')
      }
      const unresolved = await readUnresolvedWork(context.sql, context.scope.runId)
      const unresolvedByExecution = new Map<string, typeof unresolved>()
      for (const item of unresolved) {
        const causes = unresolvedByExecution.get(item.execution_id) ?? []
        causes.push(item)
        unresolvedByExecution.set(item.execution_id, causes)
      }
      const accepted = await readAcceptedWorkResults(context.sql, context.scope.runId)
      const terminals: RepeatSource[] = []
      const acceptedActivations = new Set<string>()
      for (const row of accepted) {
        const execution = HarnessExecutionSchema.parse(row.record)
        const result = AcceptedCurrentNodeResultSchema.parse(JSON.parse(row.result_json))
        if (execution.id !== row.execution_id || execution.runId !== context.scope.runId
          || execution.state !== 'completed' || !sameRepeatValue(execution.result, result)
          || !row.accepted || row.stored_activation_id !== row.activation_id || !activationIds.has(row.activation_id)
          || acceptedActivations.has(row.activation_id)
          || row.result_digest !== repeatDigest(result, 64 * 1024)) return repeatConflict('WORK_RESULT_RECEIPT_MISSING')
        acceptedActivations.add(row.activation_id)
        const workResult = await parseWorkResultLocked(context, execution, row.activation_id)
        const routing = workResult.routing
        if (routing.kind === 'return') {
          const returned = WorkReturnSchema.parse(row.returned)
          if (!sameRepeatValue(returned.scope, context.scope) || returned.sourceExecutionId !== row.execution_id
            || returned.sourceActivationId !== row.activation_id || returned.requestId !== routing.requestId
            || returned.outcome !== routing.outcome || returned.acceptedResultDigest !== row.result_digest
            || !sameRepeatValue(returned.latestDeliverable, workResult.data.latestDeliverable)
            || !sameRepeatValue(returned.remainingFindings, workResult.data.remainingFindings)) {
            return repeatConflict('WORK_RETURN_RESULT_CONFLICT')
          }
        }
        const unresolvedItems = unresolvedByExecution.get(row.execution_id)
        if (unresolvedItems) {
          const terminalWithFindings = workResult.data.remainingFindings.length > 0
            && (routing.kind === 'finish' || routing.kind === 'return' && routing.outcome === 'accepted')
          if (unresolvedItems.some((unresolvedItem) => unresolvedItem.result_digest !== row.result_digest
            || unresolvedItem.reason === 'finish_with_findings' && !terminalWithFindings
            || unresolvedItem.reason === 'repeated_exhausted_route'
              && routing.kind !== 'request' && routing.kind !== 'finish')) {
            return repeatConflict('WORK_UNRESOLVED_RECEIPT_CONFLICT')
          }
          unresolvedByExecution.delete(row.execution_id)
          if (unresolvedItems.every((item) => item.resolved)) {
            terminals.push({ relationshipId: 'terminal', execution: repeatExecutionIdentity(execution),
              occurrence: null, acceptedResultDigest: row.result_digest, acceptedResult: result })
          }
          continue
        }
        if (routing.kind === 'return' && routing.outcome === 'needs_changes') continue
        if (Number(row.source_requests)>0 || Number(row.source_denials)>0) continue
        if (routing.kind === 'request') return repeatConflict('WORK_REQUEST_UNRESOLVED')
        if (workResult.data.remainingFindings.length) return repeatConflict('WORK_UNRESOLVED_RECEIPT_MISSING')
        terminals.push({ relationshipId: 'terminal', execution: repeatExecutionIdentity(execution),
          occurrence: null, acceptedResultDigest: row.result_digest, acceptedResult: result })
      }
      if (unresolvedByExecution.size || acceptedActivations.size !== activations.length
        || !terminals.length && !unresolved.length
        || terminals.length > context.version.definition.executionPolicy!.maxNodeExecutions) {
        return repeatConflict('WORKFLOW_UNRESOLVED')
      }
      const open = unresolved.filter((item) => !item.resolved)
      // Only a Master waits for the owner's direction; any other Agent's unresolved work fails the Run with its reason.
      // A Run that already waits keeps its recorded direction interaction.
      const failure = open.length && context.hooks.run.executionState !== 'waiting'
        ? await this.unresolvedWorkFailure(context, open) : undefined
      if (failure) throw new WorkExecutionFailure(failure)
      if (open.length) {
        this.active(context)
        await this.settleAttempts(context, { kind: 'run' })
        return 'needs_direction'
      }
      if (context.hooks.run.executionState === 'completed' && !context.stopped) {
        const effect: RepeatEffect = { kind: 'run.complete', entityId: context.scope.runId, digest: repeatDigest(terminals) }
        await context.hooks.assertPublicationReceiptLocked(context.sql, effect)
        return 'completed'
      }
      this.active(context)
      if (context.version.definition.nodes.some(node => node.kind !== 'job' && node.interval)) return 'idle'
      await this.settleAttempts(context, { kind: 'run' })
      await this.effect(context, 'run.complete', context.scope.runId, terminals, [],
        () => context.hooks.completeRunLocked(context.sql, terminals))
      return 'completed'
    })
  }

  private async unresolvedWorkFailure(context: Context, items: ReadonlyArray<{ execution_id: string;
    reason: 'finish_with_findings' | 'repeated_exhausted_route' }>): Promise<ExecutionResult | undefined> {
    for (const item of items) {
      const row = (await repeatQueries.readUnresolvedExecution(context.sql, item.execution_id, context.scope.runId)).rows[0]
      if (!row) continue
      const execution = HarnessExecutionSchema.parse(row.record)
      const node = context.version.definition.nodes.find((candidate) => candidate.id === execution.workflowNodeId)
      const name = node && node.kind !== 'job' ? node.name ?? node.label ?? node.id : execution.workflowNodeId
      const findings = (await parseWorkResultLocked(context, execution, row.activation_id)).data.remainingFindings
      const detail = findings.map((finding) => typeof finding === 'string' ? finding : JSON.stringify(finding)).join('; ')
      const message = item.reason === 'finish_with_findings' ? `${name} finished with unresolved findings: ${detail}`
        : `${name} could not hand off more work: its connection reached its handoff limit. Findings: ${detail || 'none'}`
      return { outcome: 'failed', error: { code: 'WORK_FINISHED_WITH_FINDINGS',
        message: message.length > 1000 ? `${message.slice(0, 999)}…` : message, retryable: false } }
    }
    return undefined
  }

  private async workFailures(context: Context): Promise<Array<{ activationId: string; result: ExecutionResult }>> {
    const rows = (await repeatQueries.readWorkFailures(context.sql, context.scope.runId)).rows
    const failures: Array<{ activationId: string; result: ExecutionResult }> = []
    for (const row of rows) {
      const execution = HarnessExecutionSchema.parse(row.record)
      const control = await readWorkflowControlDispositionLocked(context.sql, context.scope.runId, execution.id)
      if (control.kind === 'superseded' && !['failed','canceled'].includes(control.continuation.state)) continue
      const controlledFailure = workflowControlFailure(control)
      // A retryable attempt is not a work failure while its node may still retry it.
      if (!controlledFailure && await context.hooks.allowTechnicalRetryLocked(context.sql, execution)) continue
      const result = ExecutionResultSchema.parse(controlledFailure ?? row.failure_result ?? execution.result)
      if (result.outcome !== 'failed') return repeatConflict('RUN_FAILURE_CAUSE_INVALID')
      failures.push({ activationId: row.activation_id, result })
    }
    return failures
  }
}

function assertWorkActivationReplay(stored: StoredRepeatExecution, input: WorkActivationInput): void {
  const frozen = WorkActivationInputSchema.parse(stored.input)
  const expected = { ...input }
  // Historical inputs keep their original shape; ancestry is validated separately.
  if (!('parentRequest' in frozen)) delete expected.parentRequest
  if (stored.workActivationId !== input.work.activation.activationId || !sameRepeatValue(frozen, expected)) {
    return repeatConflict('WORK_ACTIVATION_REPLAY_CONFLICT')
  }
}

async function readRepeatEffectReceipt(sql: SqlTransaction, scope: RepeatScope,
  kind: RepeatEffect['kind'], entityId: string): Promise<void> {
  const rows = await repeatQueries.readEffect(sql, scope.runId, kind, entityId)
  const digest = rows.rows[0]?.payload_digest
  if (rows.rows.length !== 1) return repeatConflict('REPEAT_EFFECT_MISSING')
  await retainRepeatEffectReceipt(sql, scope, kind, entityId, digest)
}

async function readStoredExecutionResultLocked(sql: SqlTransaction, snapshot: AcceptedRepeatRunSnapshot,
  stored: StoredRepeatExecution): Promise<HarnessExecution['result']> {
  if (!stored.accepted) return undefined
  const { run } = snapshot
  const { execution, ref } = stored
  const scope: RepeatScope = { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
    workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 }
  const rows = await repeatQueries.readStoredResult(sql, execution.id, run.id)
  const result = rows.rows[0]
  if (rows.rows.length !== 1 || !result
    || execution.state !== 'completed' || execution.result?.outcome !== 'succeeded'
    || result.occurrence_id !== (ref.occurrence?.occurrenceId ?? null)
    || !sameRepeatValue(AcceptedCurrentNodeResultSchema.parse(JSON.parse(result.result_json)), execution.result)
    || result.result_digest !== repeatDigest(execution.result, 64 * 1024)) {
    return repeatConflict('REPEAT_INPUT_NOT_ACCEPTED')
  }
  await readRepeatEffectReceipt(sql, scope, 'terminal.accept', execution.id)
  return execution.result
}

/** Historical result reads validate stored bytes and receipts without recalculating routing. */
export async function readRecordedExecutionResultLocked(sql: SqlTransaction, snapshot: AcceptedRepeatRunSnapshot,
  executionId: string): Promise<HarnessExecution['result']> {
  const stored = await readRepeatExecutionLocked(sql, snapshot, executionId)
  return readStoredExecutionResultLocked(sql, snapshot, stored)
}

/** Input admission also requires the result to agree with the terminal routing calculation. */
export async function readRepeatAcceptedResultLocked(sql: SqlTransaction, snapshot: AcceptedRepeatRunSnapshot,
  executionId: string): Promise<HarnessExecution['result']> {
  const stored = await readRepeatExecutionLocked(sql, snapshot, executionId)
  const result = await readStoredExecutionResultLocked(sql, snapshot, stored)
  if (!result) return undefined
  const { run, version } = snapshot
  const scope: RepeatScope = { workspaceId: run.workspaceId, workflowId: run.workflowId, runId: run.id,
    workflowVersionId: run.workflowVersionId, executionSemanticsVersion: 3 }
  const resolutions = await repeatQueries.readResolution(sql, run.id, stored.ref.occurrence?.occurrenceId ?? '', stored.ref.nodeId)
  const resolution = resolutions.rows[0]
  if (resolutions.rows.length !== 1 || !resolution
    || !sameRepeatValue(ResolutionSchema.parse(resolution.record),
      repeatTerminalResolution(version, scope, stored.ref, stored.execution, run.resultProtocol))) {
    return repeatConflict('REPEAT_INPUT_NOT_ACCEPTED')
  }
  return result
}

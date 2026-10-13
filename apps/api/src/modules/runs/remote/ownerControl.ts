import { DurableInteractionSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { RemoteOwnerControlSchema, RemoteOperationReceiptSchema, remoteActiveNative, type RemoteOwnerControl } from '@foreman-code/contracts/remote-execution'
import type { GraphTransactionSql } from '../../run-graph/connection.js'
import { assertGraphTransaction } from '../../run-graph/connection.js'
import type { RunOwnership } from '../ownership.js'
import type { AcceptedExecutionBinding } from '../../placement/nativeComposition.js'
import type { RemoteNativeManagerOptions } from './nativeManagerProxy.js'
import { DomainError } from '../../errors.js'
import { selectedInteractionResponse } from '../../interactions/delivery.js'
import { readAcceptedRepeatRunLocked } from '../repeatStartRead.js'
import { blockForNode, repeatId } from '../repeatResolution.js'
import { compileExecutionTopology } from '../topology.js'
import { readRepeatGraphExecutionsLocked, readRepeatGraphResolutionsLocked,
  readRepeatGraphResultsLocked } from '../../run-graph/repeatProjectionRows.js'
import { readRetainedRemoteReviewer } from '../../interactions/retainedRemoteReviewer.js'

export type RemoteControlInput = Parameters<RemoteNativeManagerOptions['controlFor']>[0]
/** SQL-only preparation inside the admitted Main transaction. The caller must
 * persist the exact command with its delivery fence before COMMIT, then deliver
 * outside G1. Preparation alone never authorizes a worker/native effect. */
export async function prepareRemoteOwnerControl(sql: GraphTransactionSql, owner: RunOwnership,
  binding: AcceptedExecutionBinding, command: RemoteControlInput): Promise<RemoteOwnerControl> {
  assertGraphTransaction(sql)
  owner.assertOwned()
  if (owner.runId !== binding.intent.runId) throw new DomainError('REMOTE_RUN_OWNER_CONFLICT', 'The original native Run owner is required.', 409)
  await owner.readOneShotFence(sql)
  const stored = (await sql.query<{ receipt: unknown }>('select receipt from remote_execution_receipts where operation_id=$1 for share', [binding.intent.operationId])).rows[0]
  const receipt = stored ? RemoteOperationReceiptSchema.parse(stored.receipt) : undefined
  if (!receipt || !sameWorkflowValue(receipt.intent, binding.intent) || !sameWorkflowValue(remoteActiveNative(receipt), command.native)
    || receipt.terminal || binding.placement.bindingHash !== binding.intent.bindingHash) throw new DomainError('REMOTE_CONTROL_UNAVAILABLE', 'The exact committed original native ownership is required.', 409)
  let commandId: string, action: RemoteOwnerControl['action']
  if (command.kind !== 'respond') {
    const cleanup = (await sql.query<{ requested_at: Date }>('select requested_at from run_cleanup_intents where run_id=$1 and pending for share', [owner.runId])).rows[0]
    if (cleanup) {
      commandId = `stop:${binding.intent.operationId}:${cleanup.requested_at.toISOString()}`
      action = { kind: 'stop' }
    } else {
      if (command.kind === 'stop') throw new DomainError('REMOTE_CONTROL_UNAVAILABLE',
        'The original accepted Run cleanup intent is required for remote Stop.', 409)
      await assertRetainedReviewerCompletion(sql, owner, binding)
      commandId = repeatId('native-close', binding.intent.operationId)
      action = { kind: 'close' }
    }
  } else {
    const rows = await sql.query<{ record: unknown }>('select record from durable_interactions where execution_id=$1 and native_session_id=$2 and native_request_id=$3 for share', [binding.intent.executionId, command.native.sessionId, command.nativeRequestId])
    const interaction = rows.rows.length === 1 ? DurableInteractionSchema.parse(rows.rows[0]!.record) : undefined
    const selected = interaction && selectedInteractionResponse(interaction)
    if (!interaction || !selected || !['decided', 'delivery_pending', 'delivery_failed'].includes(interaction.status) || !sameWorkflowValue(selected, command.option)
      || interaction.revision < 1 || interaction.runId !== owner.runId || interaction.executionId !== binding.intent.executionId
      || interaction.nativeSessionId !== command.native.sessionId || interaction.nativeRequestId !== command.nativeRequestId) throw new DomainError('REMOTE_CONTROL_UNAVAILABLE', 'The actual committed exact native response decision is required.', 409)
    commandId = `respond:${interaction.id}:${interaction.revision}`
    action = { kind: 'respond', interactionId: interaction.id, interactionRevision: String(interaction.revision), nativeInteractionId: interaction.nativeRequestId, response: selected }
  }
  return RemoteOwnerControlSchema.parse({ schemaVersion: 1, protocolVersion: 1, commandId,
    operationId: binding.intent.operationId, attemptId: binding.intent.attemptId, executionId: binding.intent.executionId,
    bindingHash: binding.intent.bindingHash, owner: binding.intent.owner, native: command.native, action })
}

async function assertRetainedReviewerCompletion(sql: GraphTransactionSql, owner: RunOwnership,
  binding: AcceptedExecutionBinding): Promise<void> {
  const denied = (): never => { throw new DomainError('REMOTE_CONTROL_UNAVAILABLE',
    'Retained reviewer close requires completed selected work and settled reviews.', 409) }
  const snapshot = await readAcceptedRepeatRunLocked(sql, owner.runId)
  if (snapshot.stopRequested || snapshot.cleanupPending || snapshot.run.outcome !== 'pending'
    || !['running', 'waiting'].includes(snapshot.run.executionState) || snapshot.version.definition.handoffs) denied()
  const row = (await sql.query<{ record: unknown }>(
    'select record from harness_executions where id=$1 and run_id=$2 for share',
    [binding.intent.executionId, owner.runId])).rows[0]
  const execution = HarnessExecutionSchema.parse(row?.record)
  if (execution.id !== binding.intent.executionId || execution.runId !== owner.runId
    || !await readRetainedRemoteReviewer(sql, execution)) denied()
  const scope = { runId: owner.runId, workspaceId: snapshot.run.workspaceId,
    workflowId: snapshot.run.workflowId, workflowVersionId: snapshot.version.id, executionSemanticsVersion: 3 as const }
  const resolutions = await readRepeatGraphResolutionsLocked(sql, scope)
  const outside = new Map(resolutions.filter(value => value.outside).map(value => [value.ref.nodeId, value]))
  const executions = await readRepeatGraphExecutionsLocked(sql, scope, { version: snapshot.version })
  if (executions.some(value => value.state !== 'completed')) denied()
  const results = new Map((await readRepeatGraphResultsLocked(sql, scope, executions))
    .map(value => [value.execution.executionId, value.resultDigest]))
  for (const nodeId of compileExecutionTopology(snapshot.version).order) {
    const block = blockForNode(snapshot.version, nodeId)
    if (block && block.exitNodeId !== nodeId) continue
    const resolution = outside.get(nodeId)
    if (!resolution || resolution.deferredRelationshipIds.length
      || !['succeeded', 'skipped'].includes(resolution.value.resolution)) denied()
    if (resolution.value.resolution === 'succeeded') {
      const identity = resolution.value.execution
      if (!identity || results.get(identity.executionId) !== resolution.value.acceptedResultDigest) denied()
    }
  }
  const pending = await sql.query(`select 1 from review_jobs j join durable_interactions i on i.id=j.interaction_id
    where i.run_id=$1 and (j.state not in ('completed','failed')
      or (j.state='failed' and j.record->'cleanup'->>'completedAt' is null)
      or j.record->'cleanup'->>'nativeState'='pending'
      or j.record->'cleanup'->>'credentialState'='pending') limit 1`, [owner.runId])
  if (pending.rowCount) denied()
  owner.assertOwned()
}

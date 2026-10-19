import { ExecutionResultSchema, HarnessExecutionSchema } from '@foreman-code/contracts'
import {
  AcceptedCurrentNodeResultSchema, WorkActivationIdentitySchema, WorkRequestSchema,
  canonicalGraphJson, parseWorkHandoffResult, type WorkRequest, type WorkflowVersionV3,
} from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import type { RepeatLockedHooks } from './repeatPostgres.js'
import { assertWorkflowExecutionCapacityLocked } from './workflowExecutionBudget.js'
import { repeatConflict, repeatId, sameRepeatValue, type RepeatScope } from './repeatResolution.js'

export interface WorkReturnContext {
  sql: GraphTransactionSql; scope: RepeatScope; version: WorkflowVersionV3
  hooks: RepeatLockedHooks; now: string
  assertActive(): void
}

export async function ensureWorkReturnContinuationLocked(context: WorkReturnContext,
  request: WorkRequest, returnId: string): Promise<string> {
  const { sql, scope } = context
  const prior = (await sql.query<{ requester_continuation_activation_id: string }>(
    `select t.requester_continuation_activation_id from run_work_returns t
      join run_work_requests q on q.run_id=t.run_id and q.request_id=t.request_id
      where q.run_id=$1 and q.requester_activation_id=$2 and t.outcome='needs_changes'
      order by t.returned_at,t.return_id limit 1`, [scope.runId, request.requesterActivationId])).rows[0]
  if (prior) return prior.requester_continuation_activation_id
  context.assertActive()
  await assertWorkflowExecutionCapacityLocked(sql, scope.runId, context.version)
  const requester = (await sql.query<{ record: unknown }>(
    'select record from run_work_activations where run_id=$1 and activation_id=$2 for share',
    [scope.runId, request.requesterActivationId])).rows[0]
  if (!requester) return repeatConflict('WORK_RETURN_REQUESTER_MISSING')
  const original = WorkActivationIdentitySchema.parse(requester.record)
  if (original.workflowNodeId !== request.requesterNodeId || !sameRepeatValue(original.scope, scope)) {
    return repeatConflict('WORK_RETURN_REQUESTER_CONFLICT')
  }
  const activationId = repeatId('work-activation', 'returns', request.requesterActivationId)
  const next = WorkActivationIdentitySchema.parse({ scope, activationId,
    workflowNodeId: request.requesterNodeId, lineageId: original.lineageId,
    cause: { kind: 'work_return', returnId } })
  await sql.query(`insert into run_work_activations(activation_id,run_id,workflow_version_id,workflow_node_id,
    cause_kind,cause_id,state,record) values($1,$2,$3,$4,'work_return',$5,'waiting',$6::jsonb)`,
  [activationId, scope.runId, scope.workflowVersionId, request.requesterNodeId, returnId, canonicalGraphJson(next)])
  return activationId
}

/** A completed native turn still owes its correlated return until routing commits it. */
export async function workRequestSettlementsLocked(context: WorkReturnContext, requesterActivationId: string) {
  const rows = (await context.sql.query<{ request: unknown; result_json: string | null;
    execution: unknown; failure_result: unknown }>(
    `select q.record as request,x.result_json,e.record as execution,b.failure_result
      from run_work_requests q
      left join run_work_returns t on t.run_id=q.run_id and t.request_id=q.request_id
      left join lateral (select h.* from harness_executions h
        where h.run_id=q.run_id and h.work_activation_id=q.destination_activation_id
        order by h.attempt desc limit 1) e on true
      left join run_work_results x on x.run_id=q.run_id and x.execution_id=e.id
      left join approval_execution_state b on b.execution_id=e.id
      where q.run_id=$1 and q.requester_activation_id=$2 and t.return_id is null order by q.request_id`,
    [context.scope.runId, requesterActivationId])).rows
  const failures: Array<{ request: WorkRequest; result: ReturnType<typeof ExecutionResultSchema.parse> }> = []
  let pending = false
  for (const row of rows) {
    if (row.result_json) {
      const result = AcceptedCurrentNodeResultSchema.parse(JSON.parse(row.result_json))
      if (parseWorkHandoffResult(result).routing.kind === 'finish') continue
    }
    const execution = row.execution ? HarnessExecutionSchema.parse(row.execution) : undefined
    const failure = row.failure_result ?? execution?.result
    if (execution && failure && (row.failure_result || execution.state === 'completed')) {
      const result = ExecutionResultSchema.parse(failure)
      if ((result.outcome === 'failed' || result.outcome === 'canceled')
        && !await context.hooks.allowTechnicalRetryLocked(context.sql, execution)) {
        failures.push({ request: WorkRequestSchema.parse(row.request), result })
        continue
      }
    }
    pending = true
  }
  return { pending, failures }
}

/** The reactivation event also records which graph task owns dispatch across replay. */
export async function resolveWaitingWorkReturnsLocked(context: WorkReturnContext,
  sourceActivationId: string): Promise<string[]> {
  const { sql, scope } = context
  const rows = (await sql.query<{ activation_id: string; workflow_node_id: string; requester_activation_id: string }>(
    `select a.activation_id,a.workflow_node_id,q.requester_activation_id from run_work_activations a
      join run_work_returns t on t.run_id=a.run_id and t.return_id=a.cause_id
      join run_work_requests q on q.run_id=t.run_id and q.request_id=t.request_id
      where a.run_id=$1 and a.cause_kind='work_return' and a.state='waiting' for update of a`,
    [scope.runId])).rows
  for (const row of rows) {
    const settled = await workRequestSettlementsLocked(context, row.requester_activation_id)
    if (settled.pending) continue
    context.assertActive()
    await sql.query(`update run_work_activations set state='queued' where run_id=$1 and activation_id=$2`,
      [scope.runId, row.activation_id])
    await sql.query(`insert into run_activity(run_id,source,kind,occurred_at,payload)
      values($1,'backend','work_requester_reactivated',$2,$3::jsonb)`,
    [scope.runId, context.now, canonicalGraphJson({ activationId: row.activation_id,
      requesterNodeId: row.workflow_node_id, sourceActivationId })])
  }
  return (await sql.query<{ activation_id: string }>(
    `select payload->>'activationId' as activation_id from run_activity
      where run_id=$1 and kind='work_requester_reactivated' and payload->>'sourceActivationId'=$2
      order by sequence`, [scope.runId, sourceActivationId])).rows.map(row => row.activation_id)
}

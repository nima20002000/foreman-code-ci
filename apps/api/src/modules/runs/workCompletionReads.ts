import type { SqlTransaction } from '../../infrastructure/transaction.js'

/*
 * The reads that decide whether a handoff Run is complete. Each takes the Run's locked transaction and returns
 * rows exactly as stored; `completeWorkRun` owns every decision made from them.
 */

export interface WorkActivationStateRow { activation_id: string; state: string }

export async function readWorkActivationStates(sql: SqlTransaction, runId: string): Promise<WorkActivationStateRow[]> {
  return (await sql.query<WorkActivationStateRow>(
    'select activation_id,state from run_work_activations where run_id=$1 order by activation_id', [runId])).rows
}

export interface UnreturnedWorkRequestRow { result_json: string | null; destination_node_id: string }

/** Requests with no recorded return whose destination did not fail. */
export async function readUnreturnedWorkRequests(sql: SqlTransaction, runId: string,
  failedActivationIds: readonly string[]): Promise<UnreturnedWorkRequestRow[]> {
  return (await sql.query<UnreturnedWorkRequestRow>(`select x.result_json,q.destination_node_id
        from run_work_requests q left join run_work_results x on x.run_id=q.run_id and x.activation_id=q.destination_activation_id
        where q.run_id=$1 and not (q.destination_activation_id=any($2::text[]))
          and not exists(select 1 from run_work_returns t where t.run_id=q.run_id and t.request_id=q.request_id)`,
  [runId, [...failedActivationIds]])).rows
}

export interface WorkDenialContinuationRow {
  denial_id: string; notice_id: string | null; delivery_state: string | null; continuation_activation_id: string | null
  activation_state: string | null; accepted: boolean
}

export async function readWorkDenialContinuations(sql: SqlTransaction, runId: string): Promise<WorkDenialContinuationRow[]> {
  return (await sql.query<WorkDenialContinuationRow>(`
        select d.denial_id,n.notice_id,n.delivery_state,n.continuation_activation_id,
          a.state as activation_state,exists(select 1 from run_work_results x
            where x.run_id=d.run_id and x.activation_id=n.continuation_activation_id) as accepted
        from run_work_denials d left join run_work_notices n on n.run_id=d.run_id
          and n.cause_kind='limit_denial' and n.cause_id=d.denial_id
          left join run_work_activations a on a.run_id=d.run_id
            and a.activation_id=n.continuation_activation_id
        where d.run_id=$1 order by d.denial_id`, [runId])).rows
}

export interface UnresolvedWorkRow {
  unresolved_id: string; execution_id: string; result_digest: string
  reason: 'finish_with_findings' | 'repeated_exhausted_route'; resolved: boolean
}

/** Unresolved work, with whether the owner's direction has since released it. */
export async function readUnresolvedWork(sql: SqlTransaction, runId: string): Promise<UnresolvedWorkRow[]> {
  return (await sql.query<UnresolvedWorkRow>(`select u.unresolved_id,u.execution_id,u.result_digest,u.reason,exists(
          select 1 from durable_interactions i join run_work_direction_responses d on d.interaction_id=i.id
          where i.run_id=u.run_id and i.record->>'kind'='work_direction' and i.status='delivered'
            and (i.record->>'selectedOptionId'='finish'
              or i.record->>'selectedOptionId'='continue' and d.continuation_run_id is not null)) as resolved
          from run_work_unresolved u where u.run_id=$1 order by u.unresolved_id`,
  [runId])).rows
}

export interface AcceptedWorkResultRow {
  record: unknown; result_json: string; result_digest: string; execution_id: string; activation_id: string
  stored_activation_id: string; accepted: boolean; source_requests: string; source_denials: string; returned: unknown | null
}

/** Every accepted work result with its execution record, request and denial counts, and recorded return. */
export async function readAcceptedWorkResults(sql: SqlTransaction, runId: string): Promise<AcceptedWorkResultRow[]> {
  return (await sql.query<AcceptedWorkResultRow>(`
          select e.record,e.accepted,e.work_activation_id as stored_activation_id,
          x.result_json,x.result_digest,x.execution_id,x.activation_id,
          (select count(*)::text from run_work_requests q where q.run_id=x.run_id and q.requester_execution_id=x.execution_id) as source_requests,
          (select count(*)::text from run_work_denials d where d.run_id=x.run_id and d.requester_execution_id=x.execution_id) as source_denials,
          (select t.record from run_work_returns t where t.run_id=x.run_id and t.source_execution_id=x.execution_id) as returned
        from run_work_results x join harness_executions e on e.id=x.execution_id
        where x.run_id=$1 order by x.execution_id`, [runId])).rows
}

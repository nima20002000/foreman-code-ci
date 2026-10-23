import type { SqlQuery, SqlTransaction } from '../../infrastructure/transaction.js'
import { CLOSED_RUN_STATES_SQL } from './runState.js'

// Query helpers use the caller's connection; orchestration owns validation and transaction boundaries.

export function readOccurrencePage(sql: SqlQuery, values: {
  runId: string; workspaceId: string; workflowId: string; workflowVersionId: string; blockId: string; afterIndex: number;
  limit: number
}) {
  return sql.query<{ record: unknown }>(`select record from run_repeat_occurrences
    where run_id=$1 and workspace_id=$2 and workflow_id=$3 and workflow_version_id=$4 and block_id=$5 and occurrence_index>$6
    order by occurrence_index limit $7`,
    [values.runId, values.workspaceId, values.workflowId, values.workflowVersionId, values.blockId, values.afterIndex,
      values.limit])
}

export function readDecisionMetadata(sql: SqlQuery, values: {
  occurrenceId: string; runId: string; workspaceId: string; workflowId: string; workflowVersionId: string
}) {
  return sql.query<{ record: unknown }>(`select d.record - 'resultData' as record from run_repeat_decisions d
    join run_repeat_occurrences o on o.occurrence_id=d.occurrence_id
    where o.occurrence_id=$1 and o.run_id=$2 and o.workspace_id=$3 and o.workflow_id=$4 and o.workflow_version_id=$5`,
    [values.occurrenceId, values.runId, values.workspaceId, values.workflowId, values.workflowVersionId])
}

export function readRunSnapshot(sql: SqlTransaction, runId: string, readOnly = false) {
  // Serialize Run mutations without excluding CI activity's parent-key read.
  const lock = readOnly ? '' : 'for no key update of r'
  return sql.query<{ run: unknown; version: unknown; stopped: boolean; cleanup: boolean; state: string; now: string }>(`select r.record as run,v.record as version,r.stop_requested_at is not null as stopped,
          r.execution_state as state,exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending) as cleanup,transaction_timestamp()::text as now
         from runs r join workflow_versions v on v.id=r.workflow_version_id where r.id=$1 ${lock}`,
    [runId])
}

export function readWaitingHierarchyGroup(sql: SqlTransaction, runId: string, activationId: string, nodeId: string) {
  return sql.query<{ group_id: string; parent_execution_id: string; state: string }>(`select group_id,parent_execution_id,state from run_hierarchy_groups where run_id=$1
            and parent_activation_id=$2 and parent_node_id=$3 for update`,
    [runId, activationId, nodeId])
}

export function readLatestWorkExecution(sql: SqlTransaction, runId: string, slotId: string) {
  return sql.query<{ execution_id: string }>(`select execution_id from run_repeat_executions where run_id=$1 and slot_id=$2
        order by technical_attempt desc limit 1`,
    [runId, slotId])
}

export function readWorkActivationState(sql: SqlTransaction, runId: string, activationId: string) {
  return sql.query<{ state: string }>('select state from run_work_activations where run_id=$1 and activation_id=$2 for update',
    [runId, activationId])
}

export function readRunningIntervalCheck(sql: SqlTransaction, runId: string, nodeId: string) {
  return sql.query(`select 1 from harness_executions where run_id=$1 and workflow_node_id=$2
      and record #> '{input,tick}' is not null and record->>'state'<>'completed' limit 1`,
    [runId, nodeId])
}

export function insertWorkSlot(sql: SqlTransaction, values: {
  slotId: string; runId: string; activationId: string; nodeId: string; inputJson: string; inputDigest: string
}) {
  return sql.query(`insert into run_repeat_slots(slot_id,run_id,occurrence_id,work_activation_id,
          workflow_node_id,input_json,input_digest) values($1,$2,null,$3,$4,$5,$6)`,
    [values.slotId, values.runId, values.activationId, values.nodeId, values.inputJson, values.inputDigest])
}

export function readWorkResult(sql: SqlTransaction, runId: string, executionId: string) {
  return sql.query<{ result_digest: string; result_json: string }>('select result_digest,result_json from run_work_results where run_id=$1 and execution_id=$2',
    [runId, executionId])
}

export function readSuccessorExecution(sql: SqlTransaction, executionId: string) {
  return sql.query<{ execution_id: string }>('select execution_id from run_repeat_executions where previous_execution_id=$1',
    [executionId])
}

export function insertWorkRepeatResult(sql: SqlTransaction, values: {
  executionId: string; runId: string; resultJson: string; resultDigest: string; acceptedAt: string
}) {
  return sql.query(`insert into run_repeat_results(execution_id,run_id,occurrence_id,result_json,result_digest,accepted_at)
            values($1,$2,null,$3,$4,$5)`,
    [values.executionId, values.runId, values.resultJson, values.resultDigest, values.acceptedAt])
}

export function insertWorkResult(sql: SqlTransaction, values: {
  executionId: string; runId: string; activationId: string | null | undefined; resultJson: string; resultDigest: string;
  acceptedAt: string
}) {
  return sql.query(`insert into run_work_results(execution_id,run_id,activation_id,result_json,result_digest,accepted_at)
            values($1,$2,$3,$4,$5,$6)`,
    [values.executionId, values.runId, values.activationId, values.resultJson, values.resultDigest, values.acceptedAt])
}

export function acceptExecution(sql: SqlTransaction, executionId: string, runId: string) {
  return sql.query('update harness_executions set accepted=true where id=$1 and run_id=$2',
    [executionId, runId])
}

export function completeWorkActivation(sql: SqlTransaction, runId: string, activationId: string | null | undefined) {
  return sql.query(`update run_work_activations set state='completed'
            where run_id=$1 and activation_id=$2`,
    [runId, activationId])
}

export function insertWorkResultActivity(sql: SqlTransaction, runId: string, executionId: string, occurredAt: string, payload: string) {
  return sql.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
            values($1,'backend','work_result_accepted',$2,$3,$4::jsonb)`,
    [runId, executionId, occurredAt, payload])
}

export function readBindings(sql: SqlTransaction, executionId: string) {
  return sql.query<{ record: unknown }>('select record from run_repeat_bindings where recipient_execution_id=$1 order by ordinal',
    [executionId])
}

export function readEffect(sql: SqlTransaction, runId: string, kind: string, entityId: string) {
  return sql.query<{ payload_digest: string }>('select payload_digest from run_repeat_effects where run_id=$1 and effect_kind=$2 and entity_id=$3',
    [runId, kind, entityId])
}

export function insertEffect(sql: SqlTransaction, values: {
  runId: string; kind: string; entityId: string; digest: string; ownerId: string; ownerFence: string
}) {
  return sql.query(`insert into run_repeat_effects(run_id,effect_kind,entity_id,payload_digest,owner_id,owner_fence)
        values($1,$2,$3,$4,$5,$6)`,
    [values.runId, values.kind, values.entityId, values.digest, values.ownerId, values.ownerFence])
}

export function readDecision(sql: SqlTransaction, occurrenceId: string) {
  return sql.query<{ record: unknown }>('select record from run_repeat_decisions where occurrence_id=$1',
    [occurrenceId])
}

export function insertOccurrence(sql: SqlTransaction, values: {
  occurrenceId: string; runId: string; workspaceId: string; workflowId: string; workflowVersionId: string;
  blockId: string; occurrenceIndex: number; bindingId: string; inputJson: string; inputDigest: string;
  previousOccurrenceId: string | null; previousOccurrenceIndex: number | null; previousDecisionId: string | null;
  previousResultDigest: string | null; record: string
}) {
  return sql.query(`insert into run_repeat_occurrences
      (occurrence_id,run_id,workspace_id,workflow_id,workflow_version_id,block_id,occurrence_index,binding_id,input_json,input_digest,
       previous_occurrence_id,previous_occurrence_index,previous_decision_id,previous_result_digest,record)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15::jsonb)`,
    [values.occurrenceId, values.runId, values.workspaceId, values.workflowId, values.workflowVersionId, values.blockId,
      values.occurrenceIndex, values.bindingId, values.inputJson, values.inputDigest, values.previousOccurrenceId,
      values.previousOccurrenceIndex, values.previousDecisionId, values.previousResultDigest, values.record])
}

export function readResolutions(sql: SqlTransaction, runId: string, occurrenceKey: string) {
  return sql.query<{ record: unknown }>(`select record from run_repeat_resolutions
      where run_id=$1 and occurrence_key=$2 order by workflow_node_id limit 1001`,
    [runId, occurrenceKey])
}

export function insertResolution(sql: SqlTransaction, values: {
  runId: string; occurrenceKey: string; nodeId: string; sourceOccurrenceId: string | null; executionId: string | null;
  record: string
}) {
  return sql.query(`insert into run_repeat_resolutions
      (run_id,occurrence_key,workflow_node_id,source_occurrence_id,execution_id,record) values($1,$2,$3,$4,$5,$6::jsonb)`,
    [values.runId, values.occurrenceKey, values.nodeId, values.sourceOccurrenceId, values.executionId, values.record])
}

export function readAcceptedResult(sql: SqlTransaction, executionId: string, runId: string) {
  return sql.query<{ result_json: string; result_digest: string }>('select result_json,result_digest from run_repeat_results where execution_id=$1 and run_id=$2',
    [executionId, runId])
}

export function readLaunchEffect(sql: SqlTransaction, runId: string, executionId: string) {
  return sql.query<{ effect_digest: string }>("select effect_digest from run_graph_effects where run_id=$1 and effect_kind='execution.launch' and entity_id=$2",
    [runId, executionId])
}

export function updateNativeExecution(sql: SqlTransaction, executionId: string, runId: string, nextRecord: string, previousRecord: string) {
  return sql.query(`update harness_executions set record=$3::jsonb
        where id=$1 and run_id=$2 and record=$4::jsonb and accepted=false returning id`,
    [executionId, runId, nextRecord, previousRecord])
}

export function readSessionConfiguration(sql: SqlTransaction, executionId: string, configurationId: string, agentId: string, workspaceId: string) {
  return sql.query<{ record: unknown; reference: unknown }>(`select c.record,s.reference from agent_configuration_versions c
       join execution_native_sessions s on s.execution_id=$1
       where c.id=$2 and c.agent_id=$3 and c.workspace_id=$4 for share of c,s`,
    [executionId, configurationId, agentId, workspaceId])
}

export function readNativeSession(sql: SqlTransaction, executionId: string) {
  return sql.query<{ reference: unknown }>('select reference from execution_native_sessions where execution_id=$1 for share',
    [executionId])
}

export function readRepairAttempts(sql: SqlTransaction, executionId: string) {
  return sql.query<{ rejected_provider_id: string }>('select rejected_provider_id from execution_work_result_repairs where execution_id=$1',
    [executionId])
}

export function insertRepairAttempt(sql: SqlTransaction, executionId: string, attempt: number, providerId: string) {
  return sql.query(`insert into execution_work_result_repairs
        (execution_id,attempt,rejected_provider_id) values($1,$2,$3)`,
    [executionId, attempt, providerId])
}

export function readClosingRun(sql: SqlTransaction, runId: string, executionId: string) {
  return sql.query(`select 1 from runs r where r.id=$1 and (
        r.stop_requested_at is not null or r.execution_state in (${CLOSED_RUN_STATES_SQL})
        or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending)
        or exists(select 1 from harness_executions e join approval_execution_state b on b.execution_id=e.id
          where e.id=$2 and e.run_id=r.id and b.failure_result is not null))`,
    [runId, executionId])
}

export function readExecutionFailure(sql: SqlTransaction, executionId: string) {
  return sql.query<{ failure_result: unknown }>('select failure_result from approval_execution_state where execution_id=$1',
    [executionId])
}

export function readCleanupFailure(sql: SqlTransaction, runId: string) {
  return sql.query<{ failure_result: unknown }>('select failure_result from run_cleanup_intents where run_id=$1',
    [runId])
}

export function insertResultActivity(sql: SqlTransaction, runId: string, executionId: string, occurredAt: string, payload: string) {
  return sql.query(`insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
          values($1,'backend','result_recorded',$2,$3,$4::jsonb)`,
    [runId, executionId, occurredAt, payload])
}

export function readAdmittedControlContinuation(sql: SqlTransaction, runId: string, executionId: string) {
  return sql.query<{ id: string }>(`select id from run_control_continuations
          where run_id=$1 and successor_execution_id=$2 and state='admitted' for update`,
    [runId, executionId])
}

export function readLatestOccurrence(sql: SqlTransaction, runId: string, blockId: string) {
  return sql.query<{ occurrence_id: string }>(`select occurrence_id from run_repeat_occurrences
        where run_id=$1 and block_id=$2 order by occurrence_index desc limit 1`,
    [runId, blockId])
}

export function readLatestSlotExecution(sql: SqlTransaction, slotId: string) {
  return sql.query<{ execution_id: string }>('select execution_id from run_repeat_executions where slot_id=$1 order by technical_attempt desc limit 1',
    [slotId])
}

export function readDecisionExists(sql: SqlTransaction, occurrenceId: string) {
  return sql.query('select 1 from run_repeat_decisions where occurrence_id=$1',
    [occurrenceId])
}

export function insertSlot(sql: SqlTransaction, values: {
  slotId: string; runId: string; occurrenceId: string | null; nodeId: string; inputJson: string; inputDigest: string
}) {
  return sql.query(`insert into run_repeat_slots(slot_id,run_id,occurrence_id,workflow_node_id,input_json,input_digest)
            values($1,$2,$3,$4,$5,$6)`,
    [values.slotId, values.runId, values.occurrenceId, values.nodeId, values.inputJson, values.inputDigest])
}

export function insertTickSlot(sql: SqlTransaction, values: {
  slotId: string; runId: string; nodeId: string; inputJson: string; inputDigest: string; tickIndex: number
}) {
  return sql.query(`insert into run_repeat_slots(slot_id,run_id,occurrence_id,workflow_node_id,input_json,input_digest,tick_index)
            values($1,$2,null,$3,$4,$5,$6)`,
    [values.slotId, values.runId, values.nodeId, values.inputJson, values.inputDigest, values.tickIndex])
}

export function insertWorkHarnessExecution(sql: SqlTransaction, values: {
  executionId: string; runId: string; nodeId: string; agentId: string; attempt: number; occurrenceId: string | null;
  activationId: string; record: string
}) {
  return sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,repeat_occurrence_id,work_activation_id,record)
        values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [values.executionId, values.runId, values.nodeId, values.agentId, values.attempt, values.occurrenceId,
      values.activationId, values.record])
}

export function insertWorkRepeatExecution(sql: SqlTransaction, values: {
  executionId: string; runId: string; slotId: string; occurrenceId: string | null; activationId: string; attempt: number;
  previousExecutionId: string | null; identity: string
}) {
  return sql.query(`insert into run_repeat_executions(execution_id,run_id,slot_id,occurrence_id,work_activation_id,
        technical_attempt,previous_execution_id,identity)
        values($1,$2,$3,$4,$5,$6,$7,$8::jsonb)`,
    [values.executionId, values.runId, values.slotId, values.occurrenceId, values.activationId, values.attempt,
      values.previousExecutionId, values.identity])
}

export function insertHarnessExecution(sql: SqlTransaction, values: {
  executionId: string; runId: string; nodeId: string; agentId: string; attempt: number; occurrenceId: string | null;
  record: string
}, tickIndex: number | null) {
  return sql.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,repeat_occurrence_id,record${tickIndex === null ? '' : ',tick_index'})
        values($1,$2,$3,$4,$5,$6,$7::jsonb${tickIndex === null ? '' : ',$8'})`,
    [values.executionId, values.runId, values.nodeId, values.agentId, values.attempt, values.occurrenceId,
      values.record, ...(tickIndex === null ? [] : [tickIndex])])
}

export function insertRepeatExecution(sql: SqlTransaction, values: {
  executionId: string; runId: string; slotId: string; occurrenceId: string | null; attempt: number;
  previousExecutionId: string | null; identity: string
}) {
  return sql.query(`insert into run_repeat_executions(execution_id,run_id,slot_id,occurrence_id,technical_attempt,previous_execution_id,identity)
        values($1,$2,$3,$4,$5,$6,$7::jsonb)`,
    [values.executionId, values.runId, values.slotId, values.occurrenceId, values.attempt, values.previousExecutionId,
      values.identity])
}

export function insertBinding(sql: SqlTransaction, values: {
  bindingId: string; runId: string; executionId: string; sourceExecutionId: string; sourceResultDigest: string;
  inputDigest: string; slotId: string; ordinal: number; record: string
}) {
  return sql.query(`insert into run_repeat_bindings
      (binding_id,run_id,recipient_execution_id,source_execution_id,source_result_digest,input_digest,slot_id,ordinal,record)
      values($1,$2,$3,$4,$5,$6,$7,$8,$9::jsonb)`,
    [values.bindingId, values.runId, values.executionId, values.sourceExecutionId, values.sourceResultDigest,
      values.inputDigest, values.slotId, values.ordinal, values.record])
}

export function insertRepeatResult(sql: SqlTransaction, values: {
  executionId: string; runId: string; occurrenceId: string | null; resultJson: string; resultDigest: string;
  acceptedAt: string
}) {
  return sql.query(`insert into run_repeat_results(execution_id,run_id,occurrence_id,result_json,result_digest,accepted_at)
            values($1,$2,$3,$4,$5,$6)`,
    [values.executionId, values.runId, values.occurrenceId, values.resultJson, values.resultDigest, values.acceptedAt])
}

export function insertDecision(sql: SqlTransaction, values: {
  decisionId: string; occurrenceId: string; executionId: string; resultDigest: string; record: string
}) {
  return sql.query(`insert into run_repeat_decisions(decision_id,occurrence_id,exit_execution_id,result_digest,record)
          values($1,$2,$3,$4,$5::jsonb)`,
    [values.decisionId, values.occurrenceId, values.executionId, values.resultDigest, values.record])
}

export function readOccurrenceAtIndex(sql: SqlTransaction, runId: string, blockId: string, occurrenceIndex: number) {
  return sql.query<{ occurrence_id: string }>(`select occurrence_id from run_repeat_occurrences
        where run_id=$1 and block_id=$2 and occurrence_index=$3`,
    [runId, blockId, occurrenceIndex])
}

export function readOccurrenceEntryExecution(sql: SqlTransaction, runId: string, occurrenceId: string, nodeId: string) {
  return sql.query<{ execution_id: string }>(`select x.execution_id
        from run_repeat_executions x join run_repeat_slots s on s.slot_id=x.slot_id
        where x.run_id=$1 and x.occurrence_id=$2 and s.workflow_node_id=$3 and x.technical_attempt=1`,
    [runId, occurrenceId, nodeId])
}

export function readUnresolvedExecution(sql: SqlTransaction, executionId: string, runId: string) {
  return sql.query<{ record: unknown; activation_id: string }>('select record,work_activation_id as activation_id from harness_executions where id=$1 and run_id=$2',
    [executionId, runId])
}

export function readWorkFailures(sql: SqlTransaction, runId: string) {
  return sql.query<{ activation_id: string; record: unknown; failure_result: unknown }>(`
      select e.work_activation_id as activation_id,e.record,b.failure_result
      from harness_executions e left join approval_execution_state b on b.execution_id=e.id
      where e.run_id=$1 and e.work_activation_id is not null and not e.accepted
        and (b.failure_result is not null or e.record#>>'{result,outcome}'='failed'
          or exists(select 1 from run_control_continuations c where c.run_id=e.run_id
            and c.previous_execution_id=e.id and c.state in ('failed','canceled'))
          or exists(select 1 from run_chat_commands c where c.run_id=e.run_id and c.kind='stop'
            and c.target#>>'{execution,executionId}'=e.id and c.state not in ('failed','canceled')))
        and not exists(select 1 from run_repeat_executions n where n.previous_execution_id=e.id)
      order by e.created_at,e.id`,
    [runId])
}

export function readStoredResult(sql: SqlTransaction, executionId: string, runId: string) {
  return sql.query<{ occurrence_id: string | null; result_json: string; result_digest: string }>('select occurrence_id,result_json,result_digest from run_repeat_results where execution_id=$1 and run_id=$2',
    [executionId, runId])
}

export function readResolution(sql: SqlTransaction, runId: string, occurrenceKey: string, nodeId: string) {
  return sql.query<{ record: unknown }>('select record from run_repeat_resolutions where run_id=$1 and occurrence_key=$2 and workflow_node_id=$3',
    [runId, occurrenceKey, nodeId])
}

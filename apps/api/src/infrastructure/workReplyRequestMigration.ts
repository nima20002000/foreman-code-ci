/** A Worker may send its finished result back to the Agent whose request started that work, over the
 * same connection. Every other request keeps its saved edge direction. */
export const workReplyRequestMigration = { version: 2026102310, sql: String.raw`
create or replace function work_reply_request(work_run_id text, requester_activation text,
  relationship text, destination_node text) returns boolean language sql stable as $$
  select exists(select 1 from run_work_requests p where p.run_id=$1
    and p.request_id=work_parent_request($1,$2) and p.relationship_id=$3 and p.requester_node_id=$4)
$$;

create or replace function assert_work_request() returns trigger language plpgsql as $$
declare pinned jsonb; work_edge jsonb; current_usage run_work_connection_usage%rowtype;
  source_activation run_work_activations%rowtype; destination_activation run_work_activations%rowtype;
  source_execution harness_executions%rowtype; accepted_digest text;
begin
  if not exists(select 1 from run_work_requests where request_id=new.request_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb
    or new.workflow_version_id is distinct from pinned->>'id' then raise exception 'WORK_POLICY_PIN_CONFLICT'; end if;
  select * into strict current_usage from run_work_connection_usage
    where run_id=new.run_id and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id;
  select value into strict work_edge from jsonb_array_elements(pinned #> '{definition,edges}') e
    where e->>'id'=new.relationship_id and e->>'kind'='execution';
  if not ((work_edge->>'source'=new.requester_node_id and work_edge->>'target'=new.destination_node_id)
      or (work_edge->>'workRequestDirection'='both' and work_edge->>'target'=new.requester_node_id
        and work_edge->>'source'=new.destination_node_id)
      or work_reply_request(new.run_id,new.requester_activation_id,new.relationship_id,new.destination_node_id))
    or new.ordinal>current_usage.used or current_usage.maximum is not null and new.ordinal>current_usage.maximum then
    raise exception 'WORK_REQUEST_ROUTE_OR_QUOTA_CONFLICT'; end if;
  select * into strict source_activation from run_work_activations where activation_id=new.requester_activation_id;
  select * into strict destination_activation from run_work_activations where activation_id=new.destination_activation_id;
  select * into strict source_execution from harness_executions where id=new.requester_execution_id;
  select result_digest into strict accepted_digest from run_work_results
    where run_id=new.run_id and execution_id=new.requester_execution_id
      and activation_id=new.requester_activation_id;
  if source_activation.run_id<>new.run_id or source_activation.workflow_node_id<>new.requester_node_id
    or source_execution.run_id<>new.run_id or source_execution.work_activation_id<>new.requester_activation_id
    or source_execution.workflow_node_id<>new.requester_node_id or not source_execution.accepted
    or source_execution.record->>'state'<>'completed'
    or accepted_digest<>new.payload_digest
    or destination_activation.run_id<>new.run_id or destination_activation.workflow_node_id<>new.destination_node_id
    or destination_activation.lineage_id<>source_activation.lineage_id
    or not (destination_activation.cause_kind='work_request' and destination_activation.cause_id=new.request_id
      or destination_activation.cause_kind='join'
        and destination_activation.cause_id=destination_activation.activation_id) then
    raise exception 'WORK_REQUEST_ANCESTRY_CONFLICT'; end if;
  if (select count(*) from run_work_requests where run_id=new.run_id
      and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id)<>current_usage.used then
    raise exception 'WORK_COUNTER_EVIDENCE_CONFLICT'; end if;
  return null;
end $$;
` }

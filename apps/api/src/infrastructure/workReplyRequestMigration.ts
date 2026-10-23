/** A Worker may send its finished result back to the Agent whose request started that work, over the
 * same connection. Every other request keeps its saved edge direction. A reply answers a handoff already
 * counted, so replies have their own ordinal and counter and never use up the connection's limit. */
export const workReplyRequestMigration = { version: 2026102310, sql: String.raw`
alter table run_work_requests add column reply boolean not null default false;
alter table run_work_connection_usage add column replies integer not null default 0 check (replies>=0);
do $$ declare ordinal_key text; begin
  select conname into strict ordinal_key from pg_constraint where conrelid='run_work_requests'::regclass
    and contype='u' and pg_get_constraintdef(oid)='UNIQUE (run_id, workflow_version_id, relationship_id, ordinal)';
  execute format('alter table run_work_requests drop constraint %I', ordinal_key);
end $$;
alter table run_work_requests add constraint run_work_requests_reply_ordinal
  unique (run_id,workflow_version_id,relationship_id,reply,ordinal);

create or replace function protect_work_usage_update() returns trigger language plpgsql as $$
begin
  if new.run_id is distinct from old.run_id or new.workflow_version_id is distinct from old.workflow_version_id
    or new.relationship_id is distinct from old.relationship_id or new.maximum is distinct from old.maximum
    or new.used<old.used or new.replies<old.replies then raise exception 'WORK_COUNTER_IMMUTABLE'; end if;
  return new;
end $$;

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
  if case when new.reply
      then not work_reply_request(new.run_id,new.requester_activation_id,new.relationship_id,new.destination_node_id)
        or new.ordinal>current_usage.replies
      else not ((work_edge->>'source'=new.requester_node_id and work_edge->>'target'=new.destination_node_id)
          or (work_edge->>'workRequestDirection'='both' and work_edge->>'target'=new.requester_node_id
            and work_edge->>'source'=new.destination_node_id))
        or new.ordinal>current_usage.used or current_usage.maximum is not null and new.ordinal>current_usage.maximum
    end then
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
  if (select count(*) from run_work_requests where run_id=new.run_id and workflow_version_id=new.workflow_version_id
      and relationship_id=new.relationship_id and reply=new.reply)
    <>case when new.reply then current_usage.replies else current_usage.used end then
    raise exception 'WORK_COUNTER_EVIDENCE_CONFLICT'; end if;
  return null;
end $$;

create or replace function assert_work_handoff_scope() returns trigger language plpgsql as $$
declare pinned jsonb; work_edge jsonb; current_usage run_work_connection_usage%rowtype;
begin
  if not exists(select 1 from runs where id=new.run_id) then return null; end if;
  pinned := repeat_pinned_version(new.run_id);
  if pinned #> '{definition,handoffs}' is distinct from '{"contractVersion":1}'::jsonb
    or pinned #> '{definition,repeat}' is not null then raise exception 'WORK_POLICY_PIN_CONFLICT'; end if;
  if tg_table_name='run_work_activations' then
    if new.workflow_version_id is distinct from pinned->>'id'
      or (select count(*) from jsonb_array_elements(pinned #> '{definition,nodes}') n
        where n->>'id'=new.workflow_node_id)<>1 then raise exception 'WORK_ACTIVATION_SCOPE_CONFLICT'; end if;
    if new.cause_kind='entry' and (new.workflow_node_id<>pinned->>'entryNodeId'
      or new.lineage_id<>new.run_id) then raise exception 'WORK_ENTRY_PIN_CONFLICT'; end if;
  elsif tg_table_name='run_work_connection_usage' then
    select * into strict current_usage from run_work_connection_usage
      where run_id=new.run_id and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id;
    select value into strict work_edge from jsonb_array_elements(pinned #> '{definition,edges}') e
      where e->>'id'=new.relationship_id and e->>'kind'='execution';
    if new.workflow_version_id is distinct from pinned->>'id'
      or current_usage.maximum is distinct from (work_edge->>'maxWorkHandoffsPerRun')::integer then
      raise exception 'WORK_CONNECTION_PIN_CONFLICT'; end if;
    if (select count(*) filter (where not reply) from run_work_requests where run_id=new.run_id
        and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id)<>current_usage.used
      or (select count(*) filter (where reply) from run_work_requests where run_id=new.run_id
        and workflow_version_id=new.workflow_version_id and relationship_id=new.relationship_id)<>current_usage.replies then
      raise exception 'WORK_COUNTER_EVIDENCE_CONFLICT'; end if;
  end if;
  return null;
end $$;

create or replace function require_work_notice() returns trigger language plpgsql as $$
declare request run_work_requests%rowtype; usage run_work_connection_usage%rowtype;
begin
  if tg_table_name='run_work_denials' then
    if exists(select 1 from run_work_denials where denial_id=new.denial_id)
      and not exists(select 1 from run_work_notices where run_id=new.run_id
        and cause_kind='limit_denial' and cause_id=new.denial_id) then
      raise exception 'WORK_DENIAL_NOTICE_MISSING'; end if;
  elsif tg_table_name='run_work_returns' and new.outcome='needs_changes' then
    select * into strict request from run_work_requests where request_id=new.request_id;
    select * into strict usage from run_work_connection_usage
      where run_id=new.run_id and relationship_id=request.relationship_id;
    if not request.reply and usage.maximum is not null and usage.used=usage.maximum
      and not exists(select 1 from run_work_notices where run_id=new.run_id
        and cause_kind='last_return' and cause_id=new.return_id) then
      raise exception 'WORK_LAST_RETURN_NOTICE_MISSING'; end if;
  end if;
  return null;
end $$;
` }

/**
 * CI no longer writes Run activity. Each ticket lifecycle observation becomes a row in `ci_activity_events` that names
 * the executions which requested the ticket; the product consumes the row (see the Run activity consumer migration).
 * CI therefore needs nothing from `runs`, `harness_executions` or `run_activity`. Requesters are not validated here:
 * the consumer keeps the ones that are exact Run executions.
 */
export const ciActivityEventsMigration = { version: 2026102320, sql: `
  create table ci_activity_events (
    id bigint generated always as identity primary key,
    workspace_id text not null,
    requester_execution_ids text[] not null,
    ticket jsonb not null,
    created_at timestamptz not null default clock_timestamp()
  );

  create or replace function record_requested_ci_activity(ticket jsonb, requester_execution_id text) returns void
  language sql volatile security invoker as $$
    insert into ci_activity_events(workspace_id,requester_execution_ids,ticket)
    values(ticket->>'workspaceId',array[requester_execution_id],ticket);
  $$;

  create or replace function record_host_ci_activity(ticket jsonb) returns void
  language plpgsql volatile security invoker as $$
  declare
    ticket_workspace_id text := ticket->>'workspaceId';
    ticket_group_id uuid := (ticket->>'groupId')::uuid;
    initiator_execution_id text := ticket#>>'{initiator,executionId}';
    requesters text[];
  begin
    -- Scalar IDs keep cached generic plans from repeatedly extracting the full ticket JSON.
    select coalesce(array_agg(requested.execution_id order by requested.execution_id),'{}'::text[]) into requesters
    from (
      select initiator_execution_id as execution_id where initiator_execution_id is not null
      union
      select q.execution_id from ci_group_requesters q
      where q.workspace_id=ticket_workspace_id and q.group_id=ticket_group_id
        and q.execution_id is not null
    ) requested;
    if cardinality(requesters)=0 then return; end if;
    insert into ci_activity_events(workspace_id,requester_execution_ids,ticket)
    values(ticket_workspace_id,requesters,ticket);
  end $$;
` } as const

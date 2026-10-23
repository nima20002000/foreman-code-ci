/**
 * Run activity consumes CI's lifecycle events. CI inserts a `ci_activity_events` row in the transaction that changes a
 * ticket; this trigger turns the row into one `ci_state_changed` activity for each requesting execution that is an
 * exact Run execution (same workspace, pinned Agent configuration), then deletes the row. The product therefore owns
 * the Run knowledge and the table stays empty. Rows would only remain if this trigger were removed, as a durable
 * outbox for an asynchronous consumer.
 */
export const ciActivityConsumerMigration = { version: 2026102321, sql: `
  create function publish_ci_activity_event() returns trigger
  language plpgsql security invoker as $$
  begin
    insert into run_activity(run_id,source,kind,harness_execution_id,occurred_at,payload)
    select r.id,'backend','ci_state_changed',e.id,clock_timestamp(),jsonb_build_object(
      'ticketId',NEW.ticket->>'id','ci',jsonb_build_object(
        'id',NEW.ticket->>'id','groupId',NEW.ticket->>'groupId','suite',NEW.ticket->>'suite',
        'part',NEW.ticket->'part','partition',NEW.ticket->'partition','state',NEW.ticket->>'state',
        'computer',case when NEW.ticket->'computer' <> 'null'::jsonb then jsonb_build_object(
          'hostRef',NEW.ticket#>'{computer,hostRef}','label',left(NEW.ticket#>>'{computer,label}',100)) else null end,
        'step',left(NEW.ticket->>'step',80),'exitCode',NEW.ticket->'exitCode',
        'queuedAt',NEW.ticket->>'queuedAt','startedAt',NEW.ticket->>'startedAt','finishedAt',NEW.ticket->>'finishedAt'))
    from harness_executions e join runs r on r.id=e.run_id
    where e.id=any(NEW.requester_execution_ids) and r.workspace_id=NEW.workspace_id
      and e.record->>'agentConfigurationVersionId'=r.record->'agentConfigurationVersionIds'->>e.agent_id
    order by r.id,e.id;
    delete from ci_activity_events where id=NEW.id;
    return null;
  end $$;
  create trigger ci_activity_event_published after insert on ci_activity_events
    for each row execute function publish_ci_activity_event();
` } as const

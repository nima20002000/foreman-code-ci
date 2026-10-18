/** A partition group keeps one input even when coverage artifacts change during execution. */
export const ciIntegrationSelectionMigration = { version: 2026101810, sql: `
  alter table ci_runs add column integration_selection jsonb;
  -- A settled sibling no longer retains its dispatch input. Re-running every slice is the only
  -- safe choice for an active legacy group; supersession cancels its old executors normally.
  with legacy_groups as materialized (
    select group_id,gen_random_uuid() as replacement_group from ci_runs
    where record->>'suite'='integration' and record->>'deriveFiles'='true'
      and record->>'supersededBy' is null
    group by group_id
    having bool_or(state in ('queued','starting','running'))
      and bool_or(state<>'queued' or record ?| array['dispatchedAt','setupRetry','executionHistory'])
  ), replacements as materialized (
    select c.*,gen_random_uuid() as replacement_id,g.replacement_group,
      row_number() over (partition by c.group_id order by c.id) as anchor
    from ci_runs c join legacy_groups g using(group_id)
  ), inserted as (
    insert into ci_runs(id,workspace_id,group_id,state,record,durations,integration_selection)
    select replacement_id,workspace_id,replacement_group,'queued',
      (select jsonb_object_agg(key,value) from jsonb_each(record)
        where key=any(array['workspaceId','suite','commit','repository','ciMirror','scope','files',
          'priority','priorityReason','gate','integrationShards','deriveFiles','defaultBranch','baseCommit',
          'branch','noSupersede','partition','part','initiator','plannedHostKey','smokeComputer',
          'expectedDurationMs','speedFactor','requiresBuildComputer']))
      || jsonb_build_object('id',replacement_id,'groupId',replacement_group,'state','queued',
        'computer',null,'step',null,'exitCode',null,'message','Restarted all partitions to freeze the selection input.',
        'queuedAt',to_char(now() at time zone 'UTC','YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'),
        'startedAt',null,'finishedAt',null),durations,
      case when anchor=1 then jsonb_build_object('changedFiles','[]'::jsonb,
        'reason','Static selection for a restarted legacy integration group.') end
    from replacements
    returning id
  )
  update ci_runs c set record=c.record || jsonb_build_object('supersededBy',r.replacement_id)
    from replacements r where c.id=r.id;
  with anchors as (
    select distinct on (c.group_id) c.id from ci_runs c
    where c.record->>'suite'='integration' and c.record->>'deriveFiles'='true'
      and not exists(select 1 from ci_runs saved where saved.group_id=c.group_id and saved.integration_selection is not null)
    order by c.group_id,c.id
  )
  update ci_runs set integration_selection=jsonb_build_object(
    'changedFiles','[]'::jsonb,
    'reason','Static selection for groups admitted before coverage inputs were saved.'
  ) where id in (select id from anchors);
  create unique index ci_runs_integration_selection_group_idx on ci_runs(group_id)
    where integration_selection is not null;
` } as const

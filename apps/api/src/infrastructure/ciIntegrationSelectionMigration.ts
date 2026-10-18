/** A partition group keeps one input even when coverage artifacts change during execution. */
export const ciIntegrationSelectionMigration = { version: 2026101810, sql: `
  alter table ci_runs add column integration_selection jsonb;
  with anchors as (
    select distinct on (group_id) id from ci_runs
    where record->>'suite'='integration' and record->>'deriveFiles'='true'
    order by group_id,id
  )
  update ci_runs set integration_selection=jsonb_build_object(
    'changedFiles','[]'::jsonb,
    'reason','Static selection for groups admitted before coverage inputs were saved.'
  ) where id in (select id from anchors);
  create unique index ci_runs_integration_selection_group_idx on ci_runs(group_id)
    where integration_selection is not null;
` } as const

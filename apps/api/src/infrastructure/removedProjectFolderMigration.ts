/** Archive removes an app-created project folder; restore recreates it from this record. Backfills workspaces
 * archived before the record existed, from the audited folder removal. */
export const removedProjectFolderMigration = { version: 2026102231, sql: `
  alter table workspaces add column if not exists removed_project_folder jsonb;
  update workspaces w set removed_project_folder = jsonb_build_object(
    'runnerId', w.execution_location->>'runnerId', 'rootPath', w.execution_location->>'rootPath')
  where w.archived_at is not null and w.created_project_folder is null and w.removed_project_folder is null
    and w.execution_location is not null
    and exists (select 1 from management_audit a where a.action = 'workspace.folder.cleanup' and a.outcome = 'succeeded'
      and a.target_key = 'workspace:' || w.id);
` }

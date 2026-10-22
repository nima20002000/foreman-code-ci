/** Owner decision (prototype permission model): new Codex Agents never ask the user for approval. Saved defaults
 * that still say "ask the user" (on-request, reviewed by the user) become "never"; Codex automatic review stays. */
export const codexNeverAskDefaultsMigration = {
  version: 2026102210,
  sql: String.raw`
    update application_settings
    set record = jsonb_set(record, '{codex,advanced,approvalPolicy}', '"never"'), revision = revision + 1, updated_at = now()
    where key = 'harness-defaults' and record #>> '{codex,advanced,approvalPolicy}' = 'on-request'
      and coalesce(record #>> '{codex,advanced,approvalsReviewer}', 'user') = 'user';

    do $never_ask$
    declare
      saved application_settings%rowtype;
      revised jsonb;
      role_name text;
      version_id text;
    begin
      select * into saved from application_settings where key = 'agent-defaults-v1' for update;
      if not found then return; end if;
      revised := saved.record;
      for role_name in select jsonb_object_keys(saved.record) loop
        if jsonb_typeof(revised -> role_name) = 'object'
          and revised #>> array[role_name, 'harness', 'harness'] = 'codex'
          and revised #>> array[role_name, 'harness', 'advanced', 'approvalPolicy'] = 'on-request'
          and coalesce(revised #>> array[role_name, 'harness', 'advanced', 'approvalsReviewer'], 'user') = 'user' then
          revised := jsonb_set(revised, array[role_name, 'harness', 'advanced', 'approvalPolicy'], '"never"');
        end if;
      end loop;
      if revised = saved.record then return; end if;

      insert into application_setting_versions (id, setting_key, version, record)
      values (coalesce(saved.current_version_id, 'agent-defaults-v1-never-ask-v' || saved.revision),
        saved.key, saved.revision, saved.record)
      on conflict (setting_key, version) do nothing;

      version_id := 'agent-defaults-v1-v' || (saved.revision + 1) || '-codex-never-ask';
      insert into application_setting_versions (id, setting_key, version, record)
      values (version_id, saved.key, saved.revision + 1, revised);
      update application_settings set record = revised, revision = saved.revision + 1,
        current_version_id = version_id, updated_at = now() where key = saved.key;
      insert into management_audit (principal_id, source, action, target_key, outcome, details)
      values (null, 'system', 'harness.defaults.codex_never_ask', saved.key, 'allowed',
        jsonb_build_object('previousRevision', saved.revision, 'revision', saved.revision + 1));
    end; $never_ask$;
  `,
} as const

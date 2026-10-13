# CI scope permissions

`ci_run` defaults to affected scope for every caller. A separate workspace-scoped
`jobs:ci_full` grant is required for `scope: "full"`, gate requests, integration
without `files`, install/build, unsupported selection, or a selection that covers
the whole suite. Ordinary CI run grants do not include it, including the default
management credential preset.

Without the grant, omitted unit/lint/typecheck files are selected on Main before
admission. Missing selectors, invalid bases and full-suite fallbacks return
`CI_FULL_SCOPE_FORBIDDEN`, with guidance to use affected scope and explicit files.
No CI tickets are created for a denial. HTTP and authenticated MCP denials are
audited. Granted callers retain runner-derived affected selection and may accept
its full-suite fallback. Gate mode uses the same full-scope admission policy.

## Issue a restricted CI credential

On the owning application's host, use its normal credential CLI:

```sh
corepack pnpm credential issue --name "CI lane" --workspace <workspace-id> --access ci-lane
```

The preset includes CI start, cancel, status, log, artifact and capability reads,
with the source/root/definition grants CI admission requires. It excludes
`jobs:ci_full`, high-priority overrides and Agent/harness management. Connect this
credential to the authenticated `/mcp` endpoint, then call:

```json
{
  "workspaceId": "<workspace-id>",
  "commandId": "<unique-command-id>",
  "suite": "integration",
  "scope": "affected",
  "commit": "<pushed-full-sha>",
  "files": ["apps/api/test/example.integration.test.ts"]
}
```

Poll every returned ticket with `ci_get`. An explicit empty file selection passes
without launching a runner. Retries must retain the command ID and input.

For a specifically authorized gate credential, add `--grant jobs:ci_full` to the
CLI command. A read-only preset rejects this grant. There is no public MCP tool
that issues credentials or escalates its own grants.

## Grant one Workflow Agent

An authorized Operator with `jobs:ci_full` can enable **Allow full-suite CI** in
the specific Agent's harness **Access & approvals** section, then save the
workflow. The equivalent MCP path is `workflow_edit_v3` with `stage_edits` and
that Agent's `harnessConfiguration.ciFullScope: true`, followed by `stop_and_save`;
use the existing revision, configuration pins and unsaved-change protocol.
Read the saved configuration through `workflow_saved_get_v3`/`agent_get`.

Both the immutable Agent configuration used by its execution and the live Run
owner grant must allow full CI. The permission is rejected in global Agent and
harness defaults. An owner grant alone does not authorize other Workflow Agents.
Revoking the owner grant denies subsequent requests and retries. Editing an
Agent affects future saved executions; existing executions keep their pinned
configuration. Native sandbox, tool allowlists and CI start grants remain
independent checks. To revoke one Agent for future executions, save
`ciFullScope: false` through the same UI or MCP path.

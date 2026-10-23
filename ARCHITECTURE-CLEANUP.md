# Architecture cleanup tracker

This file tracks the architecture audit of this repository (55 findings, 2026-10-23) and the PRs that fix them.
Update it in the same PR that changes an item's status: tick the box, add the PR to the log, and note any finding that
turned out to be wrong. To continue the work, start with [`ARCHITECTURE-HANDOFF.md`](ARCHITECTURE-HANDOFF.md).

Legend: `[x]` done · `[~]` partly done (see note) · `[ ]` open · `[-]` won't do / wrong finding

## PR log
#69–#78 are merged into the integration branch; the integration agent is fixing the test failures found there.
PRs after #78 are opened without typecheck, lint or tests, by owner decision; the integration agent runs them.

| # | PR | Scope | Base | State |
|---|----|-------|------|-------|
| 49 | `fix/a49-tailwind` | Drop Tailwind; retain browser reset and Nocturne/feature CSS appearance | #83 | implemented; CI submission blocked (`INTERNAL_ERROR`, no ticket IDs) |
| 1 | nima20002000/foreman-code#69 | CI host → `apps/ci`, server kit, package-boundary lint, wave-1 cleanups | integration | merged |
| 2a | nima20002000/foreman-code#71 | `jobs/ci*` and the Circle accounts service → `apps/ci`; CI-owned routes and tools; worker dependency; this tracker | integration | merged |
| 7 | nima20002000/foreman-code#70 | DB: one transaction helper, pools through the factory, one retry policy, migration version guard, PL/pgSQL map | integration | merged |
| 2b | nima20002000/foreman-code#72 | CI context injection replaces installed ports; 53 CI tests → `apps/ci/test` | #71 | merged |
| 10 | nima20002000/foreman-code#73 | Web: one HTTP boundary, contract shapes, shared outbox, legacy canvas removed, context split | integration | merged |
| 11 | nima20002000/foreman-code#74 | Tests: SQL-text lint rule, behavior-named helpers, one DB gate | #71 | merged |
| 3 | nima20002000/foreman-code#75 | Composition root: route registry, options object, setters and SQL out of `production.ts` | #71 | merged |
| 5 | nima20002000/foreman-code#76 | Helpers: process module, safe git runner, shared sha256, no getconf/flock duplication | #71 | merged |
| 9 | nima20002000/foreman-code#77 | Operator MCP: short descriptions with on-demand detail | #71 | merged |
| 8a | nima20002000/foreman-code#78 | Execution core part 1: run state machine, shared chat core, one execution-v1 router, coordinator deps | integration | merged |
| 8b | (PR pending) | Chat: one prompt rule set for Agent and Operator | #79 | open |
| 5b | (PR pending) | One account-status module | #79 | open |
| 5c | (PR pending) | Config: env reads through config.ts, lint rule | 5b | open |
| 9b | (PR pending) | Operator MCP: UI-only tools removed, core list trimmed, one tool_schema, budget test | #79 | open |
| 10b | (PR pending) | Web: local state in Zustand, grouped settings props, Kanban tokens | #79 | open |
| 6a | (PR pending) | Web feature boundaries: index imports, neutral shared leaves, boundary check | 10b | open |
| 11b | (PR pending) | Tests: behaviour-named symbols, one DB URL, fewer SQL-text tests | #79 | open |
| 7a | (PR pending) | #17: one durable file primitive (`shared/durableFile.ts`) for the worker operation journal and its archives | #79 | open |
| 7b | (PR pending) | #22: one deep-freeze helper for the proof/capture modules, one memory-board receipt type, one original-source check | 7a | open |
| 7c | (PR pending) | #25: SQL is canonical for duplicated rules; the rules list counts only codes SQL raises | 7b | open |
| 7d | (PR pending) | One transaction API: ExclusiveGraphConnection folded in | combined | open |
| 4a | (PR pending) | Retire opencode, legacy bridge and semantics guards; history docs | #79 | open |
| 4b | (PR pending) | Naming: wave25/V3 → current | combined | open |
| 13 | (PR pending) | Leftovers: CI sha256, syncthing spawn, CSS fallbacks | #79 | open |
| 8b | (PR pending) | #16 harness capability descriptors replace provider-name steer checks | #79 | open |
| 8c | (PR pending) | #15 shared turn core: text pipeline, output loop and observe helpers for Agent and Operator chat | 8b | open |
| 8d | (PR pending) | #13 coordinator split: session lifecycle, consultations, reviewer sessions and cancellation collaborators | 8c | open |
| 8e | (PR pending) | #21 split `openLocked`, `admitWorkHandoffLocked` and `qualifyVerificationRuntime` | 8d | open |
| 8f | (PR pending) | #14 graph/handoff/hierarchy run modes in the repeat runtime and engine | 8e | open |
| 8g | (PR pending) | #20 chat services and `completeWorkRun` SQL moved into repositories | 8f | open |
| 8h | (PR pending) | #18 one LangGraph adapter: re-exports, pinned contract and the PostgresSaver internals facade | 8g | open |
| 3b | (PR pending) | Composition root: typed factories, no service-locator bag | #79 | open |
| 3c | (PR pending) | production.ts leftovers: logic, SQL and setters moved out | 3b | open |
| 12a | (PR pending) | CI owns its table migrations, CI activity events replace run_activity triggers, CI read API | #79 | open |
| 12b | (PR pending) | CI ticket client (in-process and HTTP transports), CI protocol package for the test-result message | 12a | open |
| 12c | (PR pending) | Machine administration: OS packages and restarts move to the CI host-agent package; byte-transfer inventory | 12b | open |
| 6a | (PR pending) | API module boundaries: checker, pending list, index entry points | #79 | open |
| 6b | (PR pending) | Layering: infrastructure no longer imports modules (except the checkpoint saver); Operator extensions built in composition | 6a | open |
| 6c | (PR pending) | Worker imports API through package entry points; verification runner loaded through one server file | 6b | open |
| 6d | (PR pending) | Contracts-node: plan and blockers for the Node-only contracts split (no code moved) | 6c | open |

## Owner decisions
- CI becomes its own product, but it keeps running exactly as today: `pnpm test → ci-remote → Main ci_run`, CircleCI
  and GitHub dispatch through mirrors, the build-computer runner, and release Clean-Round tickets.
- CircleCI stays reachable in the app while CI moves.
- CI scripts (`scripts/ci-*.mjs`, `ci-suite.sh`) and the contracts CI tooling are a protocol with the repo under
  test. They stay at their paths until CI gets its own repo.
- New CI suite names need the deployed Main to know them first, so tests join existing suites.
- Agent models: only Sonnet agents at high effort, for all work, run as parallel streams.
- PR authors run no typecheck, lint, tests or other heavy checks. The integration agent runs them.
- #43 Operator MCP:
  - Remove `workflow_kanban_layout_get/_set`, `workflow_reorder`, `computers_maintenance_status/_start`,
    `workspace_storage_folders_list`, `workspace_storage_folder_delete`, `workspace_folder_undo` and
    `workspace_folder_rename`. They are UI layout, display or maintenance features; the HTTP routes stay.
  - Move `agent_defaults_get` and `workflow_create` off the core list; both stay reachable through discovery.
  - Merge `operator_tool_schema_get` into `tool_schema`.
  - Add a test that the core `tools/list` stays under a size ceiling.
- #15: Agent and Operator chat use one shared prompt rule set. The Operator keeps only its receipt-only recovery,
  which skips the size check.
- #34: the one name is `current` (`contracts/wave25` → `contracts/current`, `V3` symbols → `Current`). The saved value
  `executionSemantics: 3`, migration SQL and migration versions stay.
- #35: rename graphql in code now. Deployed names (compose projects, database and user, volumes, `GRAPHQL_*`
  variables, `~/.local/share/graphql*` paths) stay frozen in one module, with no alias layer, until one cutover that
  renames them together. The cutover runs only with the owner's explicit go-ahead, because it touches the deployed
  machine.
- #24: no migration squash and no down migrations. Migrations stay forward-only; recovery is a backup restore.
- #18: put the LangGraph `dist` patch and the `PostgresSaver` subclass behind one adapter now; don't wait for upstream.
- Running and integrating PRs (tests, conflicts, merges) is the local integration agent's job.

## Corrections to the audit
- `hono` is not unused: `@modelcontextprotocol/node` needs it as a peer. Dropped.
- `features/agents/agentDirectoryStore.ts` is live through `AgentsDirectory`. `features/combined/` is a live router test.
- #15: Agent and Operator chat share 25 method names, not ~48, and their turn models genuinely differ (#78).
- #23: the four execution-v1 routers already used the same 1 MiB limit and dispatch order (#78).
- Merging #69–#78 left the integration branch with an older copy of this tracker and without the handoff; both are
  restored.
- `docs/handoffs/architecture-cleanup-tools/` (the web codemod and cycle scripts the handoff names) is not in the
  repository. 6a did the web rewrite with throwaway scripts. For the cycle check, run the exported functions of
  `scripts/check-import-cycles.mjs` over `apps/web/src` (`sourceImportGraph(['apps/web/src'])`).
- #36: `LegacyChatDeliveryBridge` is not legacy. It is the shared HTTP and MCP chat delivery adapter that both chat
  services install, so it cannot be removed; only the name and file were misleading (now `ChatDeliveryBridge` in
  `workflow-chat/deliveryBridge.ts`). Its `*Legacy*` method names on the chat services are untouched.
- #36: the OpenCode "156 refs" are mostly the deliberate retired-history boundary, not an active harness; no driver,
  runtime or write path for OpenCode exists.

## Findings by planned PR

### CI part 2 (#71, #72)
- [~] #1 CI system embedded in the product. A01 implements the HTTP ticket/lifecycle boundary and remaining CI read moves; Foreman CI verification is blocked by the inherited worker lockfile mismatch.
  - Moved to `apps/ci`: `ci-host` (#69), plus `jobs/ci*` and the Circle accounts service (#71).
  - CI owns its routes and MCP tool specs (#71).
  - PR 12a: the 25 `ci*` migrations plus `hostCiRuns`, `hostCiActivity` and `agentCiActivity` live in
    `apps/ci/src/migrations` (`@foreman-code/ci/migrations`). The one runner applies them, with the same entries, order
    and versions. CI tables stay in the same schema, not a `ci` schema: tests migrate one random schema per test, so a
    shared `ci` schema would break their isolation. The CI-owned tables are `ci_runs`, `ci_group_requesters`,
    `ci_request_groups`, `ci_dispatch_claims`, `ci_file_durations`, `ci_test_result_cache`, `ci_runtime_preparations`,
    `ci_enrollment_*` and `ci_activity_events`.
  - PR 12a: CI triggers no longer write `run_activity`. They insert `ci_activity_events`; the Run-owned trigger
    `publish_ci_activity_event` (`modules/runs/ciActivityConsumerMigration.ts`) turns each event into the same
    `ci_state_changed` activity in the same transaction and deletes the row.
  - PR 12a: `runs/agentCiSnapshot` and the `computers/activity` CI reads, plus the `runs/history`, `runs/agentRunStatus`
    and `runs/workflowDeliverable` ticket reads, go through `@foreman-code/ci/ciReadApi` (adapter `modules/ci/reads.ts`).
  - A01: `runs/activitiesSql` ticket evidence and `bug-reports/stuckExecutions` ticket aggregates now come from the
    CI read API, preserving the same transaction snapshot, indexed lookups and detector locks.
  - Still open: FKs from CI tables to product tables; the move into a `ci` schema; contracts CI tooling.
- [x] #30 (CI part): the worker declares `@foreman-code/ci` and imports CI by package name (#71); it builds its own CI
  context (#72). The rest of #30 is open: about 40 other `apps/api` modules are imported by the worker.
  - Still in the product: 25 CI migrations (PR 12); non-CI SQL reading CI tables (`runs/agentCiSnapshot`, the
    `computers/activity` cloud reads); contracts CI tooling.
- [~] #30 Implemented: worker source and tests consume API package exports, including a test-only verification fixture export.
  Worker bundling still resolves the exported source graph; test fixtures exercise those same entry points.
  CI blocked on `fix/a30-worker`: submissions return `INTERNAL_ERROR` / `DATABASE_BUSY`; no tickets issued.
- [x] Integration coverage maps `apps/ci/dist` back to `apps/ci/src` (#71).
- [~] Service locator replaced by `CiContext` injection (#72, draft, API side not typechecked).
- [~] CI tests in `apps/ci` (#72): 53 moved, running in `unit-other`. About 122 stay in `apps/api/test/ci-host`
  because they need real git, CI DB priority, Main's private filesystem or API fixtures.

### Jobs verification (unscheduled)
- [~] #31 Implemented: verification runner, reports, process and capability modules live in `packages/verification-runner`.
  Script wrappers preserve pre-install commands and imports. Worker artifacts, API runtime, production runtime,
  fixture cache and CI context share `runtime-files.mjs`; installed scripts retain their flattened paths.
  CI blocked on `fix/a30-worker`: submissions return `INTERNAL_ERROR` / `DATABASE_BUSY`; no tickets issued.

### PR 3: Composition root (#75, draft)
- [x] #6 `production.ts` `ProductionComposition` service-locator bag (unsafe cast, ~146 assignments, `!.`). Each `configure*` is
  now a `create*` factory returning a typed object (same call order). Services reached before they are built go through
  `ProductionCallbacks` (one `Late` slot each, `composition/late.ts`); services that exist only after startup are in
  `StartedServices`; lifecycle flags are in `ProductionState`. Not typechecked (owner decision).
- [x] #7 Business logic, authorization and SQL in `production.ts`.
  - Moved out earlier: profile authority, device host override, provider-accounts worker authority, rsync transfer
    authority, main provisioning target, and the Run-principal query (one function, used in four places).
  - Moved out in 3c: the workflow manager resolver (`runs/workflowManagerResolver.ts`) and context preparation
    (`runs/workflowManagerContext.ts`), launch credentials (`interactions/executionCredentials.ts`), chat profile
    selection and compaction recovery (`conversations/chatSources.ts`), the Worker native-output context and the placed
    continuation check (`placement/`), with their SQL in `readRunWorkflowScopeForShare`, `readStoredRemoteReceipt` and
    `readExecutionWorkflowNode`.
  - Completed: the Agent chat and Operator per-harness manager allocation now lives in
    `conversations/managerResolvers.ts`; `createConversationManagers` and `createAgentChat` only wire the factories.
- [x] #8 Missing wiring surfaces as runtime 503s. Guards that only checked wiring (`remoteWorkflow`, `workerChats`,
  `runtimeOwner`, `browserRemote`) and the `!.` reads are gone. Guards on real startup state keep their codes; no test
  asserts any of them.
- [x] #9 Setter wiring.
  - Removed earlier: `bindTarget` ×2, `bindRouting`, `bindProfiles`, `useWorkDirectionActions`, `setRootPolicies`,
    `configureDevices`.
  - Removed in 3c: the `launchScopes`/`claudeLaunches` WeakMaps (one `NativeLaunchRecords` object, passed to its writers and
    readers), the Operator and Agent chat resolver function properties (factory arguments), the
    `jobRuntime.*.enrollment` and `jobs.runtimePreparation` assignments (`createProductionJobs({ ci })`), and
    `registerApprovalCheckpointResume` in production (an `InteractionService` constructor argument; the function stays for
    test fixtures that build the service first).
- [x] #10 Routes registered in four places: `routes/registry.ts` is the one registry, and the route table is identical
  (457 routes before startup, 554 after).
- [x] #11 Second composition root in `devices/installedWorkerDomains.ts`: `createWorker*` factories, one `WorkerState`
  record, and two `Late` slots (update drain, workflow activation). Its `process.env` reads use `hostEnvironment()`.
- [x] #12 Test-mode branches: `buildProductionApp(options)`, a `computerUpkeep` option, and one replay value.

### PR 4: Naming (not started)
- [x] #34 Remaining `Wave25…` TypeScript identifiers renamed to `Current…`; non-history contract docs now use `contracts/current`.
  (#74 renamed `test/wave25` → `test/native-projection` and the test helpers.)
  PR 4b renamed the code names to `current`: `contracts/wave25` → `contracts/current` (subpath, directory and
  every importer), `interactions/wave25/` → `interactions/current/`, and all 82 `*V3*` identifiers → `*Current*`
  (2,824 occurrences; no name collided, so none was skipped). `RepeatGraphCurrentV3` became
  `RepeatGraphCurrentCurrent`, which the owner should review. Left alone: `wave25_*` SQL,
  migration file names, `wave25*` test file names, string literals, JSON keys, prose, docs and history.
- [ ] #35 Unfinished graphql → foreman-code rename (646 files; compose/DB names, rsync path, env compat layer).
  Deployed names need a migration plan.
- [~] #36 Retired `opencode` harness (156 refs), `LegacyChatDeliveryBridge`, 24 semantics-version guards.
  - Done: one `isReadOnlyHarnessConfiguration` (contracts) replaces 8 copies of the "retired or read-only" check, and one
    `retiredHarnessError()` (`harnesses/retiredHarness.ts`) replaces 20 `HARNESS_RETIRED` throws. The unused
    semantics-2 `workflows/triggerAuthority.ts` is deleted. The bridge is renamed `ChatDeliveryBridge` (see
    corrections).
  - Kept on purpose: the read schemas and enum values for stored OpenCode rows (`HarnessConfigurationSchema`,
    `RecordedOperatorChatSettingsSchema`, `RecordedHarnessQualificationSchema`, subagent and session-control
    providers, the `check (harness in (...))` constraints), the `HARNESS_RETIRED` 409 for saved OpenCode history, and
    the retired-defaults reads in `settings/postgres.ts`. Write inputs already reject OpenCode
    (`SupportedHarnessConfigurationSchema`, `AgentHarnessSchema`).
  - Open: the same two helpers are not applied in `production.ts`, `interactions/execution.ts` and
    `conversations/agentChat|operatorChat|workerProduction.ts` (other streams were editing them), nor in the web
    (`features/**`, ~90 refs, all retired-history display). Narrowing `HarnessConfiguration` to Codex and Claude, with a
    separate recorded union for reads, would remove the remaining `=== 'opencode'` branches; it needs a typecheck run.
  - The 24 semantics-version guards are all `!== 3` fences over historical rows; they stay. The `oneShot*` owner
    fences are not semantics 1/2 (keep, per ENG-07 R04).
- [x] #37 Ticket-named docs: 34 top-level files (ENG, FEAT, FIL, NIM, SCH, CHAT) and `docs/reviews/` moved under
  `docs/history/` with their links fixed; the ENG-03 evidence and the ENG-04 handoff are kept there. Links pinned to
  commit `16b3337` in the ENG-07 documents stay as they are. Still named after waves or tickets outside `docs/history`:
  `agent-chat-f3|g4|h2.md`, `startup-hardening-todo.md`, `docs/integration/w07-*`, `docs/plans/f1-f4`.

### PR 5: Duplicated helpers (#76, draft)
- [x] #38 Process spawning: `shared/process.ts` and `shared/git.ts` (safe flags), wrappers migrated, and a lint rule
  against `node:child_process` (#76). `syncthingSystem` spawns nothing itself: it runs commands through
  `accountProbe.systemPorts`, which already uses `runProcessSettled`. It moves out of the API with PR 12.
- [~] #39 Shell-outs: getconf replaced by `/proc/self/auxv`, shared `fileLock.ts` (#76). The python `renameat2`,
  `syncfs` and `F_SETLEASE` calls and the containerised `node -e` programs stay, documented.
- [x] #40 Login/account detection: one `provider-accounts/accountStatus.ts` (pure parsers and credential paths) used by
  `computers/accountProbe.ts`, `provider-accounts/nativeCommands.ts` and `localCredentials.ts` (5b).
- [~] #41 DB retry helpers (#70) and inline sha256 (#76, 194 chains, lint rule) are done; CI is excluded.
- [x] #42 Config: settings reads moved to lazy accessors in `config.ts` (`codexHomeDirectory`, `executionRetryBackoffOverrideMs`,
  `configuredHome`, `configuredSearchPath`, `configuredTemporaryDirectory`, `hasGraphicalSession`,
  `DEFAULT_HARNESS_WORKSPACE_ROOT`); pass-through environments use `hostEnvironment()`. The API lint forbids
  `process.env` outside config, the process module, server, cli, production, tests and `installedWorkerDomains.ts`
  (composition, owned with #6/#8/#11; convert it with that work and drop the override). Modules that `config.ts`
  imports (logger, harness binaries) and `profilePath.ts` (worker bundle) read through `hostEnvironment()` to avoid an
  import cycle or server-only imports. `readDeviceListenerConfig` stays in `devices/productionConfig.ts`: it parses a
  passed-in environment, not `process.env` (5c).
- [ ] #40 Login/account detection in 3–4 places.
- [x] #41 DB retry helpers (#70) and inline sha256 (#76, 194 chains, lint rule) are done. CI uses the same helpers: they
  moved to `@foreman-code/contracts/server-kit` (the Node-only kit both packages already import), `shared/hash.ts`
  re-exports them, and `apps/ci` has the same lint rule. `warmSetup` keeps its incremental `createHash`.
- [ ] #42 Config: ~90 direct `process.env` reads outside `config.ts`.

### PR 6: Module boundaries (not started, except CI and web groundwork)
- [~] #29 No module boundaries.
  - The CI↔API boundary is enforced (#69).
  - Web (6a): cross-feature imports go through the feature's index (759 imports rewritten; 13 features gained an
    index). The shared graph/Board leaves live in the neutral `features/board-core` (geometry, collaborationFields,
    signalEdge, graph types/mapper/layout, draft state/model/agentEdits/agentForm, Board context and keys).
    `scripts/check-web-feature-boundaries.mjs` (web lint) fails on any new import of another feature's internals; test
    files and test support modules (fixtures, testSupport, mocks) may import each other. The runtime import graph still
    has only the 2 earlier cycles (one moved with `agentEdits`/`model` into `board-core`).
  - Web, still open: 97 imports in `scripts/web-feature-boundary-pending.mjs` (a list that may only shrink). About 49 sit on
    real feature cycles: `graph/store` and the draft hooks ↔ `workflow-board` start/stop outboxes, `AgentControls` ↔
    `AgentSettingsForm`, `agents/agentSettings`, `schedules/queries`. about 48 are `operator-chat` ↔ `conversations` chat
    pieces that tests reach through a mocked `conversations` or `operator-chat` index; move the shared chat pieces
    (`ChatNotice`, `chatTimeline`, `chatAttachmentAttempt`, `sessionControls`, …) into a neutral feature, then re-point
    the mocks. `routes/WorkspaceRouteEntry` → `WorkflowBoard` and `shared/ui/WorkspaceShell` → `HarnessStatusMenu` are
    layering inversions to fix on their own.
  - Open: 75 bidirectional API module pairs.
- [ ] #32 Layering inversions: infrastructure→modules (24 imports), MCP builds services that HTTP uses, `collaboration`
  duplicates `workflow-chat`.
  - API (6a, not typechecked or linted): `scripts/check-api-module-boundaries.mjs` runs in the API lint. A module
    imports another module only through its `index.ts`, and no two modules import each other; tests are not checked.
    Violations that predate it are in `scripts/api-module-boundaries-pending.mjs`, a list that may only shrink
    (`--prune` removes fixed lines). 1,135 internal imports became 730 by adding `index.ts` to 32 modules and routing
    importers through them, but only where it added no import cycle and no file to the worker's import closure; the
    rest of the importers of each module are still listed. 78 mutual pairs became 77 (HarnessExecutionError moved to
    `shared/`). The count is 78 rather than 75 because type-only and dynamic imports count.
  - Left in the pending list, by imported module: harnesses 119, runs 108, access 60, files 58, devices 55,
    sources 50, interactions 46, run-graph 43, jobs 40, and 20 or fewer for the other 18 modules. Each remaining
    importer would form an import cycle through the barrel, or (for `browser-runtime`, `browser-profiles`, `skills`,
    `subagents`, parts of `computers`) widen the worker's import closure, or imports a name the converter could not
    classify. About 30 mutual pairs come from `devices/installedWorkerDomains.ts` and the `production*.ts` and
    `serverPorts.ts` composition files inside modules; they go away with #11 and #32.
  - Not converted automatically: imports of names that are re-exported from another file, and default or namespace
    imports. Add them to the index by hand.
  - Open: web cross-feature imports (425, 392 into internals). There is a codemod for the web part (see the handoff).
- [~] #32 Layering inversions: saver infrastructure imports removed; owner decision pending (Foreman CI blocked by inherited lockfile setup failure).
  - Infrastructure→modules: 24 imports became 2 non-test imports (the logging core, ten migration files, storage
    roots and `DomainError` moved or were replaced). Follow-up: `ApprovalPostgresSaver` now belongs to
    `modules/runs`; its transaction assertion uses the public `run-graph` entry and its SQL type remains in
    infrastructure. The checkpoint-store factory moved to `composition/checkpoints.ts`; all consumers, mocks and
    local acceptance entrypoints use the new paths. SQL, transaction checks and saved/deployed names are unchanged.
    The earlier two-import count was stale: the saver had one runtime module import and no remaining module type
    import. Separate migration-registry imports into CI/runs remain outside this saver cleanup. Two infrastructure
    tests also still import `ExclusiveGraphConnection`.
  - Verification: cleanup commit `431eb159d3d260c3a8b7af78a21c3e974668827a`, Foreman tickets:
    affected unit (13 files) `c3460e6e-8d5e-44ea-a426-d386e47c746d`, affected integration (9 files)
    `da1e10a6-6f2e-46cf-84d5-449b24f8f080`, full typecheck `ed7b5e06-4588-491f-b5cb-fc445f9eda10`,
    full lint `5796f310-f845-4b32-a1b1-78d1f1b27bcc`. Unit/typecheck/lint failed before execution during
    installation; integration's first attempt failed there too. The logs report `ERR_PNPM_OUTDATED_LOCKFILE`:
    worker requires `@foreman-code/api@workspace:*`, absent from the lockfile. Base typecheck ticket
    `7f6f62b6-4769-4f25-8a6e-344b78b6396a` at `1d6b544d7a` has the identical setup failure; both affected
    dependency files are unchanged here. No local tests, typecheck, lint or builds ran; no passing result or
    touched-file diagnostics are available. Re-run CI after the integration agent repairs the base lockfile.
  - `modules/diagnostics/{logger,logComponent,runtimeTiming,ignoredError,operationalFailures,rotatingLogDestination,appErrors}.ts`
    are now one-line re-exports of the files in `infrastructure/`, so import paths and test mocks keep working.
    A test that mocks `diagnostics/logger.js` no longer intercepts infrastructure's own logger calls; mock
    `infrastructure/logger.js` for those.
  - `createOperatorExtensions` (agents, skills, version history, workspace controls), which HTTP routes use through
    `services.extensions`, moved from `mcp/operator/` to `composition/operatorExtensions.ts`. It was the only service
    construction in `mcp/`. `OperatorServices` (the shared service bag type) still lives in `mcp/operator/types.ts`.
  - `collaboration` and `workflow-chat` are not duplicates in a mechanical way: `collaboration/workflowChat*` is the
    Run-owned execution chat (HTTP, Group chat and MCP admission), `workflow-chat` is the Group chat channel. Not
    merged; the owner must choose the boundary.
  - Owner options (no design change implemented):
    1. Keep separate modules: `collaboration` owns exact Run-target admission, owner transactions and native
       dispatch; `workflow-chat` owns Group posts, prepared deliveries and reply projection. Move their shared
       delivery ports/types into a neutral boundary and inject the Run adapter during composition to remove the
       mutual imports. This preserves the two distinct durable lifecycles.
    2. Consolidate the execution-chat files under `workflow-chat` with explicit execution/channel subareas, leaving
       browser and memory-board collaboration separate. This groups chat code together, but requires a larger
       import/mocking migration and careful preservation of owner transactions versus Group pending delivery.
    Recommendation: option 1. `WorkflowChatService.post` retains a Group post before its pending drain dispatches,
    whereas `WorkflowExecutionChatService.deliver` admits a command under the existing Run owner and reconciles
    native submission. They share delivery contracts, not one transaction/lifecycle. Resolve the mutual dependency
    through composition rather than merging these services. Await the owner's choice before implementing either.
- [~] #33 Contracts carries runtime code. #69 and #71 added `server-kit` and `installed-runtime-node` there on purpose.
  Split the Node-only code into its own package.
  - 6d stopped before moving code: the new package is a third built workspace package, and it cannot be added safely
    without running the build and CI. Nothing is moved on this branch.
  - What moves: `serverKit`, `installedRuntimeNode`, `localClientNode`, `deviceIdentityNode` and `deviceSetupNode`
    (it imports `deviceIdentityNode`) with their tests, into `packages/contracts-node` (`@foreman-code/contracts-node`,
    built to `dist`, exports like contracts). 85 files import `server-kit`, 22 `installed-runtime-node`, 30
    `device-identity-node`, 4 `local-client-node`; 12 worker and script files import the sources by relative path.
    `deviceSetupNode` also imports `deviceTlsNode`, which would move too. The contracts modules they import
    (`job-runtime`, `job-verification-runtime`, `source-admission`, `source-materialization`, `device-identity`,
    `device-setup`, `product`, the index) all have subpath exports already. The CI tooling stays in contracts (owner
    decision).
  - Wiring found that has to change with it, none of which was done:
    - Build: every `--filter @foreman-code/contracts build` site (root `package.json` x5, `ci-suite.sh`,
      `apps/ci/src/runner.ts`, `dev.mjs`, `acceptance/local.mjs`, `test-integration.mjs`, `test-native-acceptance.mjs`,
      `.github/workflows/ci-cache.yml`) and the pinned call sequences in `ci-suite.test.mjs`, `ci-affected.test.mjs`,
      `local-production.test.mjs` and `apps/api/test/ci-host/*`. An alternative that keeps them untouched is building
      contracts-node from the contracts `build` script, but `heavy-job.mjs --build contracts` hashes only
      `packages/contracts`, so it would need to hash both directories.
    - Required portions: `verification-runner.mjs` `expectedPortions` makes every `apps/*` or `packages/*` package with
      a `typecheck`, `lint` or `build` script a required portion, and unit tests need a `vitest` portion; the root
      scripts must then produce them. The moved tests could instead run in the API unit suite.
    - Release packaging: `local-production-runtime.mjs` special-cases the contracts and CI packages (copy, immutable
      snapshot, `apiDependencyKey` inputs, stale-output pruning) and `local-production.test.mjs` pins it.
    - Worker artifact: `workerPackages` and the alias lists in `worker-snapshot-policy.mjs` and
      `build-worker-artifact.mjs`, `ciWorkspacePackages` in `ciImportGraph.mjs`, and the project lists in
      `ci-affected*.mjs`, `ci-typecheck-cache.mjs`, `test-files.mjs`, `lint-baseline.mjs` and
      `test-fixture-cache.mjs`; `pnpm install` for `pnpm-lock.yaml`.
  - Suggested order: do it in one PR with a person running `pnpm typecheck`, `lint`, `test` and the local-production
    tests, starting with the build and portion wiring, then the importer rename (a codemod on the four subpaths).

### PR 7: Database (#70)
- [-] #24 Migrations: registry overrides removed, version-order guard for new migrations (#70). Squash and down
  migrations won't be done (owner decision).
- [~] #25 PL/pgSQL: implemented; CI verification blocked. One SQL rule → `DomainError` mapper at the owning transaction boundary
  maps the 25 inventoried codes only with their exact SQLSTATE/message, retaining the original cause and safe 409
  messages. Unknown failures and existing domain errors retain their identity; retries and rollback/recovery stay
  ahead of mapping, including command-owned `TransactionSession` failures after compensation. Removed the write path's redundant repeat decision/successor validators; deferred SQL checks
  remain canonical. Kept parsing/computation, read-side checks and recoverable in-transaction pre-checks, which the
  substring-based inventory had also counted. No migration or saved/deployed name changed.
  - Verification: tests committed before the mapper (`3ed374e4cf`, corrected fixture/ownership coverage
    `79c6e6b346`; command-session regression `e1c980a81c`); Foreman rejected both pre-fix unit/integration submissions with `INTERNAL_ERROR` and final focused
    submissions with `DATABASE_BUSY`, so neither red/green regression evidence nor clean changed-file checks is
    established. Baseline full typecheck ticket `39a0f485-5450-471c-ba45-1463a51fb0b2` and lint ticket
    `686d250c-16dd-4c0a-bccf-042cb1bb7bfd` were issued; final full typecheck/lint admission is pending.
    No tests, compiler, lint or builds ran locally. Rerun affected tests and full typecheck/lint when CI recovers.
- [~] #26 Transactions: one `withTransaction`, and the delivery ALS is now private. 7d (written without running the
  typecheck, lint or tests):
  - `ExclusiveGraphConnection.transaction` now calls `withTransaction` for BEGIN, COMMIT and rollback. The helper
    gained `rollback` (a strategy that sees the failed phase and returns the error when the connection is unusable),
    `runtimeTiming`, `origin` and `rollbackWithRecovery`. The connection keeps only what is graph-specific: the
    statement queue and guard, before-commit finalizers, poisoning and the unknown-COMMIT rule.
  - `GraphSqlClient` and `GraphTransactionSql` are gone; the 291 files that used them import `SqlQuery` and
    `SqlTransaction` from `infrastructure/transaction`. The class and the lease helpers (`beforeGraphCommit`,
    `assertGraphTransaction`, ...) stay in `run-graph/connection.ts` with their importers; they are the guard around the
    transaction, not a second transaction API.
  - File cleanup (two repositories), project folder cleanup, interaction decisions, delivery, worker credentials and
    artifact binding moved onto `withTransaction`. The command coordinator is the one session that needs a transaction
    held open across its own callbacks and session locks; it uses the named `TransactionSession`.
  - Done in `fix/a26-txn`: converted the 34 integration-test files that called begin/commit/rollback primitives to
    `withTransaction`, preserving caller-owned connections and lock lifetimes. The test-only primitives remain
    exported for other integration fixtures. `failedCaptureCleanup.ts` lost a redundant
    `rollbackTransaction` that `withTransaction` already did. The file cleanups now commit instead of rolling back on
    their no-write `stale` and `busy` outcomes. Run typecheck, lint and the file, interaction and run-graph
    integration tests before merging.
- [x] #27 Pools only through the factory, plus lint rule `foreman/no-raw-database-pools`.
- [-] #28 Schema still allows semantics 1/2. Won't do: `in (1,2,3)` keeps retained historical versions readable,
  and new publications already require 3 through a trigger.

### PR 8: Execution core (#78 is part 1, draft)
- [~] #13 `ApprovalExecutionCoordinator`: a typed dependencies object; `RunExecutionCapacity` and
  `NativeCredentialLedger` extracted. The session lifecycle (`executionSessionLifecycle.ts`), consultations
  (`executionConsultations.ts`), reviewer sessions (`executionReviewerSessions.ts`) and Stop/restart cancellation
  (`executionCancellation.ts`) are now collaborators that share the coordinator through `ExecutionSessionHost`; the
  coordinator keeps one-line delegates for its public methods. Still in the coordinator (about 2.3k lines): workflow
  observation, attach/restore, run-owner sharing and the workflow-chat owner.
- [~] #14 "repeat" is the universal run engine despite AGENTS.md. `runs/workflowRunMode.ts` names the three modes
  (`graph`, `handoff`, `hierarchy`; only explicit repeat blocks declare repeat). `executeRepeatRuntime` now takes a
  `WorkflowGraphMode` (`handoffGraphMode` or `workflowGraphMode`) instead of branching on `work`/`repeat`, the native
  prompt contract per mode is `nativeWorkContracts`, and the engine asks `usesWorkHandoffGraph`. Finding #14 follow-up:
  `workflowExecutionRequest.ts`, `repeatPostgres.ts` and `workflowLifecycle.ts` now use the shared
  `usesWorkHandoffGraph`/`isHierarchyWorkflow` predicates instead of branching on saved handoff/hierarchy fields;
  completion uses `declaresRepeatBlocks`. Behavior and saved names are unchanged. Open: the `repeat*`
  file and symbol names (`repeatRuntime.ts`, `repeatNode.ts`, `repeatGraph.ts`, `RepeatRunRepository`) still cover
  the ordinary graph; renaming them remains a separate mechanical follow-up.
- [~] #15 Two chat engines: shared `conversationEngine.ts` and `conversationRepositoryCore.ts`, and an Operator
  unsubscribe bug fixed. Web: the two Agent conversation panels now share `AgentConversationContent`; the three
  composers share draft/menu handling and native command dispatch where applicable. Five stream adapters share
  contract decoding, with common event binding and connection-local duplicate/gap tracking. Existing delivery,
  rendering and reconnect policies stay with their adapters. Web verification is pending Foreman CI: the base
  ticket `d52d2a6a-ca61-4b99-9d4d-a8b03a4e6422` fails frozen install on the pre-existing worker lockfile mismatch;
  final affected-unit/full-typecheck/full-lint requests returned `DATABASE_BUSY` before issuing tickets.
  `runTurn`, observe/settle and recovery retain engine-specific behavior.
  Prompt rules are shared (`refineChatPrompt` in contracts): text-or-attachment and no attachments on steer apply to the
  Agent, Operator and canonical send schemas, and the size check to Agent and Operator; only Operator receipt recovery
  skips the size check.
- [ ] #16 Leaky harness port (capability descriptors not started).
- [~] #17 Durable-write consolidation complete (`fix/a17-durable`); JSON journal storage migration remains deferred.
  - Done (7a, written without compiling or running tests): `shared/durableFile.ts` (`writeDurableFile`,
    `readBoundedText`, `readBoundedTextIfPresent`, with its own test) is the only atomic write and bounded read.
    `operationJournal.ts`, `runtimeJournalArchive.ts` and `workerConversationArchive.ts` use it; their copies of
    temp-file/fsync/rename/directory-fsync and stat-then-read are gone, and the archives no longer take an injected
    `write` function. The on-disk format, paths and limits are unchanged, so existing journals open as before.
  - Not done: `node:sqlite`. Node 22.22 has it, but it is still experimental (warning on load), `engines` allows
    `>=22.0.0` where it needs a flag, and the journal is a snapshot plus six hash-addressed archive trees whose
    crash-recovery and owner-lock behaviour tests pin. Moving them needs a one-time migration and the DB tests run.
  - Done (`fix/a17-durable`): the nine remaining copies in
    `browser-runtime/{journal,files,processIdentity,profileCheckpoint,snapshotStorage}.ts`,
    `harnesses/{workerManagedMcp,claudeSdk/compactionResults,compatibility/cache}.ts` and `apps/ci/src/cloudJournal.ts`
    use the same writer, now in `contracts/durableFileNode.ts`, exported through the existing Node-only `server-kit`
    entry and re-exported by `shared/durableFile.ts`. Caller privacy checks, existing-parent requirements, temporary
    names, serialized bytes and the cache's lack of directory fsync stay intact. Focused durability/ownership tests
    added. Foreman CI verification blocked: affected unit/integration requests returned `INTERNAL_ERROR`; full
    typecheck/lint requests returned `DATABASE_BUSY` before issuing tickets (base also has an outdated worker lockfile).
  - Sources of truth (from reading; not exhaustive). Run state is canonical in Postgres on Main (`runs`,
    `execution_dispatch_intents`, `remote_execution_receipts`, `job_executions`). The worker `RemoteOperationJournal`
    is canonical only for what happened on that worker before Main accepted it (entry reserved, native identity,
    controls); Main copies each receipt sequence into `remote_execution_receipts` (`runs/remote/persistence.ts`) and
    never reads the worker file. Main-hosted jobs also keep a journal (`jobs/mainJobJournal.ts`) next to
    `job_executions`, reconciled by `retainMainJobSourceClosures`. CI run state is canonical in Postgres `ci_runs`;
    `apps/ci` cloud runs also keep a `runs/<id>/meta.json` ownership file, which is canonical for the cloud provider's
    side only. No duplicate was removable mechanically; the journal and the DB row are different facts that must
    both survive a crash.
- [ ] #18 LangGraph patched in `dist` and subclassed via internals.
- [x] #19 Run state machine: `runs/runState.ts`, with every `execution_state` write going through
  `writeRunStateLocked`.
- [~] #20 SQL extraction implemented; Foreman CI verification blocked (details in the #20 follow-up below).
- [~] #21 Monster functions: `dispatchReview` split. Open: `openLocked`, `workHandoffAdmission`.
- [x] #22 Proof/verification/receipt sprawl: matching shapes shared; distinct proof models retained.
- [ ] #20 SQL mixed into orchestration.
- [~] #21 Monster functions: existing splits retained; `qualifyVerificationRuntime` now also names command,
  report, ordinary-suite and interruption steps, preserving effect order (branch `fix/a21-qualify`).
  Implemented; Foreman verification blocked before checks by the base worker dependency/lockfile mismatch.
- [~] #22 Proof/verification/receipt sprawl.
  - Done (7b, written without compiling or running tests): `shared/deepFreeze.ts` (`deepFreeze`, `frozenJsonCopy`, with a
    test) replaces six private copies in `interactions/{workflow,review}NativeCapture.ts`,
    `runs/remote/workflowPhysicalReadout.ts`, `harnesses/instanceRegistry.ts`,
    `harnesses/instanceSettings/acceptedProfile.ts` and `placement/binding.ts`. `memory-boards` `MutationReceipt` is now an
    alias of the contract's `MemoryBoardMutationReceipt` (they were the same shape). `placement/remoteNativeSource.ts`
    has one `readOriginal` check instead of two copies. Persisted data and HTTP/MCP shapes are untouched.
  - Follow-up (`fix/a22-proof`): `shared/nativeCapture.ts` shares the exact four-field `NativeCaptureLane` between
    workflow capture, reviewer capture and the remote workflow lifetime. Workflow/remote lanes remain nullable;
    reviewer lanes remain required, and existing readonly modifiers stay unchanged. This is API-private provenance,
    not a new HTTP/MCP contract. Only type declarations and type-only imports change.
  - Intentionally separate after comparing the shapes: `Workflow`/`Review`
    `NativeProofRecord`/`Services` and `NativeVerificationPort` (parallel, ~700 and ~230 lines, different tables and
    leases); `RemoteTerminalEvidence`, `RemoteJobTerminalEvidence` and `NativeTerminalEvidence` (three different
    persisted shapes); `CodexMessagePublicationReceipt`/`ClaudeMessagePublicationReceipt` (differ in
    `nativeTurnId`/`nativeMessageId`); the single and batch physical verification ports in `remoteNativeSource.ts`.
  unsubscribe bug fixed. `conversationTurnCore.ts` now holds the turn mechanics both engines share: the text
  pipeline, the per-event output loop (engine hooks for activity, admission and pending interactions) and the
  history-match helpers for observe. The engines keep their own settle (Agent `repository.finish`, Operator terminal
  journal and runtime closure), failure classification and recovery, because those turn models genuinely differ. The
  web consolidation is described in #15 above.
- [~] #16 Leaky harness port: `harnesses/capabilities.ts` holds the steer/compact descriptors, adapters declare
  `harnessCapabilities` on the port, and the steer qualification (conversations, session writer, Worker host, workflow
  chat receipts) asks `supportsExpectedTurnSteer` instead of comparing `'codex'`. Open: other provider-name branches
  outside `harnesses/` (plugin/MCP maintenance, activity normalisation, Claude-only file and journal paths).
- [ ] #17 `operationJournal` hand-rolled JSON DB; 2–3 sources of truth for run/CI state.
- [~] #18 LangGraph patched in `dist` and subclassed via internals. `infrastructure/langgraph.ts` is now the one
  module that touches LangGraph: it re-exports the graph primitives and checkpoint types, records the pinned contract
  (the `dist` patch and what it does), and holds `LangGraphPostgresSaver`, the only class that calls PostgresSaver's
  protected `_dump*` helpers. `CheckpointMutationSaver` and `ApprovalPostgresSaver` extend it; no other `apps/api/src`
  module imports `@langchain/*`. Open: the patch itself stays until upstream observes background checkpoint writes;
  tests under `apps/api/test` still import `@langchain/langgraph` directly.
- [x] #19 Run state machine: `runs/runState.ts`, with every `execution_state` write going through
  `writeRunStateLocked`.
- [~] #20 SQL mixed into orchestration. Moved to repositories: `completeWorkRun`'s five reads
  (`runs/workCompletionReads.ts`), the Agent chat service's direct queries (`PostgresAgentChatRepository`: node scope,
  retained target, request replay, context lock, session defaults, chat browser, Run source reference) and the
  Operator chat service's three (`conversationIdsWithUnconfirmedSteers`, `settleUnconfirmedSteer`,
  `hasDeliveryCommandForTarget`). Repeat SQL extraction (Finding #20 follow-up): all 64 query calls, including
  `unresolvedWorkFailure`/`workFailures`, now use 52 typed helpers in `runs/repeatQueries.ts`. Decisions,
  validation, SQL text, parameters and transaction/publication order are preserved. Implementation committed as
  `4806d2f4b4` on `fix/a20-repeatsql`; verification blocked by Foreman CI: affected unit/integration and full
  typecheck/lint submissions returned `INTERNAL_ERROR` without tickets, including a unit retry. Baseline tickets:
  unit `dd52396a-7438-44de-a6d5-302c128264c5`, integration `7d0adccb-a121-432e-839d-d2d86f348478`,
  typecheck `aeff0eed-b945-4d05-a085-7687f2b54995`, lint `314f0256-970f-42b6-bb14-7de1282de5fe`.
  No local checks were run; rerun the selected files and full typecheck/lint when CI admission/collection recovers.
- [x] #21 Monster functions: `dispatchReview` split (#78). `openLocked` (`repeatRepositoryHost.ts`) is now run-pin,
  publication, shared fences, memory hooks, run hooks and native hooks; `admitWorkHandoffLocked`
  (`workHandoffAdmission.ts`) is route, replay, usage, denial and acceptance; `qualifyVerificationRuntime`
  (`verificationQualification.ts`) delegates quota claims, workspace, runtime and isolation checks, quota pressure,
  the qualification plan, the suite context and the final result to helpers. Steps run in the original order.
- [x] #23 One `executionExtension` factory for all four execution-v1 sides.

### PR 9: Operator MCP (#77, draft)
- [x] #43 Descriptions shortened: catalog description text went from 162k to 73k characters, and the core-list
  descriptions from 20.8k to 4.0k. Detail is now served on demand. Owner decisions applied (PR 9b, written without
  running anything): removed `workflow_kanban_layout_get/_set`, `workflow_reorder`, `computers_maintenance_status/_start`,
  `workspace_storage_folders_list`, `workspace_storage_folder_delete`, `workspace_folder_undo` and
  `workspace_folder_rename` (HTTP routes and services stay; their tool-level tests now use HTTP or the service);
  `agent_defaults_get` and `workflow_create` left the core list; `operator_tool_schema_get` is merged into
  `tool_schema` (adds `includeOutputSchema` and `permissionRequirements`, the latter only for callers with
  `capabilities:read`); a budget test bounds the `tools/list` size. The ceiling is an estimate: the integration
  agent sets it to the measured size rounded up to the next 1,000 characters.

### PR 10: Web (#73, draft)
- [x] #44 One HTTP boundary (transport, eventStream, bytes, apiError).
- [x] #45 API shapes come from contracts.
- [x] #46 One command-outbox utility for all 7 outboxes (#73). The Query-as-local-store uses are in Zustand (10b): the
  agent-chat command readbacks, the completed-turn marks, and the Codex plugin and managed MCP operations. One store per
  `QueryClient` (`shared/api/clientScopedStore.ts`) keeps their old lifetime. Server reads that are only fetched on
  demand (`enabled: false` plus a real `queryFn`) stay in Query.
- [x] #47 Dead code: `SelectedRunCanvas`, `TerminalPlaceholder` (#69), and the legacy graph canvas (#73).
- [x] #48 Board context split into 3; `AgentSettingsForm` takes a typed save value; 5 `JSON.stringify` keys replaced
  (#73). Its 33 props are grouped into `node`, `workflow`, `placementChoices`, `draft` and `slots` plus 4 callbacks
  (10b); the unused `placementStage` and `workflowNodeCount` props are gone.
- [~] #49 Implementation complete; verification blocked by Foreman CI submission (`INTERNAL_ERROR`, no tickets).
  One styling system: Nocturne tokens and feature CSS. `useOutsidePress`, Kanban tokens,
  `--color-*` alias removal and dead token-fallback cleanup came from #73/10b. Tailwind dependencies, Vite/Vitest
  plugins and the build-cache tool requirement are removed in `fix/a49-tailwind`. The named components and both dev
  showcases already use feature/Nocturne classes; no utility-class migration was needed. App-owned `reset.css` retains
  the previous browser defaults in the base cascade layer. The two floating windows use `--shadow-window` with the
  previous Tailwind shadow value, and the graph panel keeps its 0.75rem text size without a Tailwind variable.
- [~] #48 Board context split into 3; `AgentSettingsForm` takes a typed save value; 5 `JSON.stringify` keys replaced.
  The 36 props are not grouped yet.
- [x] The 31 pre-existing web type errors are fixed (#73).

### PR 11: Tests (#74, draft)
- [~] #50 Helper second codebase: 58 helpers and 129 tests renamed after behavior; `check-test-names` covers
  helpers and directories. 11b (#79): about 50 ticket-named exported symbols renamed across all importers
  (`agent3Database`, `seedAgent3`, `nim2691TaskDatabase`, `sch11*`, `br1002*`, `br2001*`, `runEng03NativeScenario`,
  `fil14*`, `a1Scenario`, `native2Fixture`, `F1*`, `af*`), five unused helpers deleted, `fil14Lifecycle.ts` renamed,
  and `agent3Database` merged into `migratedDatabase` (its own-schema branch had no caller). Open: `ENG03_A_*` env
  names other than the database URL, ticket-named web support files (`eng05D`/`eng07B`), and the schema fixture
  `currentDatabase` next to the database fixture `migratedDatabase`.
- [~] #51 SQL-text tests: part 2 (`fix/a51-sql2`, base entries 46–90) has four conversions awaiting CI;
  the other 41 files and earlier bound-value/call-order conversions remain. Four SQL exemptions are removed (135 → 131);
  completion remains blocked on verification.
  CI is blocked before code checks by the base worker manifest/lockfile mismatch (`ERR_PNPM_OUTDATED_LOCKFILE`);
  base typecheck `8e01b77e-0a1d-4eba-905d-9105f4938904` and lint `2c9ca564-2d04-40cf-bc2b-0783fa33dd16`.
  The lint rule now catches SQL-text tests regardless of variable name. The remaining violations are
  listed in `pendingSqlTextTests.mjs` (209 files, a list that may only shrink). 11b (#79) cleared 20 files with two
- [~] #51 SQL-text tests: the lint rule now catches them regardless of variable name. The remaining violations are
  listed in `pendingSqlTextTests.mjs` (130 files, a list that may only shrink). Part 1 owns the original first
  45 entries (`computers/sync.test.ts` through `agent-chat-f2-recovery.test.ts`). Five replacements are implemented
  on `fix/a51-sql1`: sync repository membership, Claude publication receipts (extending the existing integration
  suite), failed-capture cleanup/locks, Git worktree identity, and node-skill authoring. Foreman verification is
  pending; baseline ticket `0b58461b-c665-4c38-a7c5-0311fab228b0` already reports a cached-store install setup
  failure. The other 40 entries and earlier bound-value/call-order fakes in this range remain open.
  11b (#79) cleared 20 files with two
  shared seams, `livePrincipal` (the live principal read) and `commandReceiptLedger` (conversation control receipts),
  which recognise statements by their bound values instead of SQL text, plus bound-value checks in a few fakes. The rest
  route several tables on SQL text; they need real-Postgres integration tests or a fake at a port.
  - Part 3 (`fix/a51-sql3`, base `1d6b544d7a`): **in progress, CI blocked**. Ownership is the last 45 of the
    base's 135 pending entries (harness-profile-selection-persistence through workflow-node-history-compatibility).
    Nine entries converted: profile selection persistence, Operator submitted ACK/terminal messages, Run authority,
    graph transactions, reviewer cleanup/fencing, continuation upgrade, and selected-run admission lock observation.
    Persistence tests use migrated Postgres; SQL predicate assertions are replaced by saved rows and public results.
    Pending list: 135 → 126. The other 36 entries and earlier call-order/value-count conversions in this third remain.
    Verification is incomplete: base lint `8dc9a1cc-bd0c-4ea3-a005-b59dd74e6192` failed at cached-store installation;
    base typecheck `8fdadc5a-0567-4178-a610-13c9badbd5b3` was submitted. Repeated focused integration and final
    typecheck/lint submissions returned `DATABASE_BUSY`/`INTERNAL_ERROR` during CI admission. No local checks run.
- [x] #52 Stale lint allowlist pruned: 674 → 276 (#69), then → 116 files (#74).
- [x] #53 DB test gating: one `postgresEnabled` gate on `TEST_DATABASE_URL` (#74). 11b (#79) removed
  `ENG03_A_TEST_DATABASE_URL` and `WAVE25_TEST_DATABASE_URL` from the acceptance runner, the test-resource environment,
  the native acceptance docs and the tests that read them. `OPERATOR_NATIVE_TEST_DATABASE_URL` still overrides in one
  acceptance file.
- [~] #54 Release gates: behavior names, and the live-production config documented. The 20 s default is unchanged.
  11b (#79): `installedRuntimeQualification.test.ts` hashed the whole Node binary in every fixture (now once per
  file) and `job-capabilities.test.ts` built up to five Operator MCP servers in one case (now one per case). Both are
  unmeasured; the flakiness is not confirmed gone.

### PR 12: CI as its own service/repo (12a–12c open)
- [~] #2 Machine administration inside the API (apt upgrade, reboot, Syncthing, Xvfb/Chromium).
  - 12c done: OS packages and restarts (apt-get inspection and upgrade, the sudo check, reboot-required, the restart
    command) are `HostSystem` in `apps/ci/src/hostAdmin`, reached through `HostAdministration`
    (`@foreman-code/ci/hostAdmin`, adapter `modules/ci/hostAdmin.ts`). `ComputerMaintenance` calls it with its own ports,
    so Main and paired computers keep the same behaviour. Tested in `apps/ci/test/hostSystem.test.ts`.
  - Finding #2 follow-up (`fix/a02-hostadmin`): Syncthing system preparation, availability, conflict scanning and
    computer operations now live in `apps/ci/src/hostAdmin`; API adapters supply the existing process ports and logger.
    `HostAdministration.syncthing` and `.browser` describe the host-owned components alongside `.system`.
    The host also owns Xvfb adoption/start/stop and Chromium launch flags, environment, spawning, startup failures and
    runtime-directory cleanup. CDP sessions and profile bookkeeping stay in the API. Saved paths, service names,
    request/response schemas and SQL are unchanged. Code is moved; verification is blocked: Foreman CI returned
    `DATABASE_BUSY` / `INTERNAL_ERROR` before issuing tickets (including full typecheck and lint requests).
    The bounded conflict-scan behavior tests moved with their owner; new host-browser behavior tests cover launch and failures.
- [~] #3 Five ways to move bytes between machines. Inventory (verified in code, 12c); nothing is migrated yet.
  - Open, because each needs a compile to move safely: Syncthing (`computers/syncthingSystem`, `syncthingAvailability`,
    `syncthingConflictScan`, `syncthingComputer`; they use `accountProbe.systemPorts`, `shared/hash` and the API's
    `DomainError`, and `SyncthingPorts` is already an interface) and the Xvfb display (`browser-runtime/virtualDisplay`;
    it uses `browser-runtime/journal`, `processIdentity`, `shared/process` and `apps/worker/src/browserRuntimeInstall.mjs`).
    Chromium launch (`browser-runtime/nativeDriver`, 732 lines) belongs with the display. Add each to
    `HostAdministration` as a second member next to `system`.
- [~] #3 Five ways to move bytes between machines. Job-input production callers now share the resumable carrier; verification blocked by Foreman CI on `fix/a03-bytes` (not complete). Browser, Agent snapshot and Worker update callers remain in the order below.
  1. The resumable chunked carrier: `ResumableByteTransferService` and `ResumableByteTransferSender`
     (`modules/byte-transfer`, namespace `byte-transfer-v1`, `ByteTransferPort` in `contracts/byte-transfer`). Workflow
     artifacts, job outputs and source packages use it.
  2. rsync over SSH (`modules/byte-transfer/rsync*`, `files/jobInputs/rsync*`, `files/jobs/rsync*`,
     `runs/remote/installed*Rsync*`, `sources/rsyncTransferLifecycle`). It is a backend of 1: it stages into the same
     journal as an `rsync-source` or `rsync-receiver` hold under the same intent and authorization.
  3. The job-input channel: `files/jobInputs` (`job-inputs-v1`), with its own protocol and an rsync variant.
  4. Worker update download: `computers/workerArtifacts*` (`worker-update-v1`, its own binary frames). Installed
     Workers in the field speak it, so it needs a compatibility window.
  5. Browser upload/download chunks: `collaboration/browserByteTransfers`, `browser-runtime/files|media|pairedMedia`.
  Also: Syncthing shared folders (`computers/sync*`) and the Agent snapshot git bundle (`agent-snapshot-v1`).
  - Chosen target: mechanism 1. It is the only one with durable journals, resume, quotas, ownership records and
    per-operation authorization, and 2 already rides on it. Migration order: job inputs (3) onto `ByteTransferPort`
    with a `to-worker` intent, then browser chunks (5, needs a new intent class because they have no accepted attempt),
    then the Agent snapshot bundle; the Worker update (4) last, once no installed Worker needs the old namespace.
  - Job inputs: ordinary installed Workers now use the same durable admission and staging handshake as rsync,
    with `ByteTransferPort` on `byte-transfer-v1` and Main-issued `to-worker` intents. Main selects the shared
    chunked sender when no rsync backend was selected. The existing rsync selection, saved admissions,
    detached-delivery ACK/readback, HTTP/MCP responses and receipt names stay unchanged.
  - CI blocker (2026-10-23): affected unit, full typecheck and full lint requests for `04b10b3fe1`
    returned `INTERNAL_ERROR` without ticket IDs. Base `1d6b544d7a` tickets
    `7f6f62b6-4769-4f25-8a6e-344b78b6396a` (typecheck) and
    `746e5518-3198-475a-904a-29ade0491871` (lint) failed before checks at package install
    (`ERR_PNPM_OUTDATED_LOCKFILE` for `apps/worker/package.json`; offline package metadata also failed).
    No local tests/checks were run. Job-input verification must pass before advancing to browser callers.
  - Remaining in order: browser chunks (new intent class; no accepted attempt), Agent snapshot bundles, then
    Worker updates only after installed-Worker compatibility is established. Each step needs integration and
    physical rsync verification before this finding can close.
- [ ] #4 `pnpm test` runs through Main's CI. Kept by owner decision until CI is separate.
- [ ] #5 Three CI systems. Kept by owner decision.
- [~] CI owns its schema (12a: migrations moved, activity events, read API; the `ci` schema move is open), an HTTP
  client replaces the in-process ports, and a protocol package holds the `ci-*.mjs` tooling.
  - 12b: `CiTicketClient` (`@foreman-code/ci/client`) is the product's view of CI's ticket operations. `HostCiService`
    remains the CI implementation; A01 wires `HttpCiClient` in production through a private loopback listener with
    an ephemeral service credential, carrying the original caller and audit source (including workspace inference).
    The MCP CI tools, the CI routes and the tool specs depend on the interface. The routes now accept the `ci_get` wait/test-status options and a cancel `commandId`. Not done:
    the Circle accounts, enrollment and runtime-preparation clients. A01 adds authenticated service routes for
    `dispatch`, `cancelStoppedRun` and `expireOverdueRuns`, used by the product; CI owns its own start/close lifecycle.
  - 12b: `packages/ci-protocol` holds the test-result message (`CI_TEST_RESULT_LIMITS`, `ciTestResults`) that
    `scripts/ci-test-results.mjs` writes and Main reads; the script imports it by relative path and keeps its path.
    A script test guards it against `CiTestResultsSchema`. Not done: `apps/ci` does not import the package yet, because
    that needs the Worker bundler aliases and the release packaging to carry it. `pnpm-lock.yaml` needs
    `packages/ci-protocol: {}` under `importers` (run `pnpm install`).

### Dropped
- [-] #55 `hono` unused: wrong, it is a required peer.

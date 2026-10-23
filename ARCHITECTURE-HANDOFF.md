# Architecture cleanup handoff

## 0. Handoff to the terminal agent (2026-10-23, after the combined PR)
This replaces the older notes below wherever they disagree.

**What the combined PR is.** One branch, `claude/arch-cleanup`, merges every architecture stream written after #69–#78.
The owner's rules applied: Sonnet agents at high effort, Haiku for mechanical renames, and **nothing was typechecked,
linted or tested** (some agents ran parse-only scripts and `check-import-cycles`). The streams were written in parallel
and merged here with conflicts resolved by hand, so expect compile errors where they meet. Each stream's own branch
(`claude/arch-*`) stays pushed if you need to bisect.

**Step 1: get it green on the integration branch.**
1. `corepack pnpm install` (new workspace packages: `packages/ci-protocol`; `apps/worker` now depends on
   `@foreman-code/api`; `pnpm-lock.yaml` was not edited by hand).
2. Build contracts and ci before the API (`@foreman-code/ci` now ships the CI migrations, loaded from `dist`).
3. Typecheck and lint everything; fix the errors. Expected hot spots, in rough order:
   - `apps/api/src/production.ts` and `composition/late.ts` (typed factories, `Late.get()` narrowing, `Pick<…>` deps).
   - `interactions/execution.ts` and its four new collaborators (`ExecutionSessionHost` `Pick`, about 35 members that
     lost `private`).
   - generated module `index.ts` re-exports (`check-api-module-boundaries.mjs`) and web feature indexes.
   - `infrastructure/transaction.ts` (`withTransaction` options, `TransactionSession`) and the 291 files whose
     `GraphSqlClient`/`GraphTransactionSql` imports became `SqlQuery`/`SqlTransaction`.
   - contracts `refineChatPrompt` typing; `isReadOnlyHarnessConfiguration` call sites; `retiredHarnessError` imports.
   - the `…V3` → `…Current` and `contracts/wave25` → `contracts/current` renames (1,100+ files, parser-based).
4. **Lint exemptions.** At least 25 files listed in `scripts/lint-allowlist.json` changed content, so their exemptions
   dropped. Fix their violations; never add to the allowlist. `node scripts/lint-baseline.mjs` prunes passing entries.
5. **New checks to keep green:** `scripts/check-api-module-boundaries.mjs` (pending list may only shrink; new
   violations from merged code must be fixed, not listed) and `scripts/check-web-feature-boundaries.mjs`.
6. Run unit, integration and acceptance in full. Suites the stream authors named as most at risk: approval and
   restart coordinator, Agent and Operator chat integration, repeat and handoff, checkpoint and approval-resume,
   migrations and migration integrity (new versions 2026102320 and 2026102321), `agent-ci-activity`,
   `run-start-query-count`, file/interaction/command/run-graph integration, worker artifact build and
   `check-worker-imports`.
7. Set `LISTED_TOOLS_CEILING_CHARACTERS` in `apps/api/test/operator-tool-registry.test.ts` to the measured size rounded
   up to the next 1,000 characters.
8. Regenerate `docs/architecture/database-functions.md` with `apps/api/scripts/database-functions-doc.mjs`
   (it was hand-edited).
9. Tidy `ARCHITECTURE-CLEANUP.md`: it was merged with `merge=union`, so some finding lines and PR-log rows appear twice.
   Keep one line per finding (the most complete) and replace the "(PR pending)" rows with the combined PR.

**Step 2: the remaining work, with Sonnet agents (Haiku only for pure find-and-replace).** One agent per job; split a
job only when it is too large for one agent. Each item below was stopped on purpose because it needed a compiler.
- **Unfinished renames.**
  - #34: the `Wave25…` TypeScript identifiers (about 117, e.g. `Wave25InteractionRepository`) → `Current…`, and
    non-history docs that still name `contracts/wave25`. Keep `wave25_` SQL identifiers, migration names, test file
    names and string literals.
  - #35: not merged. Branch `claude/arch-rename-graphql` has one unreviewed commit that may rename frozen names, so
    redo it. Rename code only; freeze deployed and saved names (compose projects, database and user, volumes,
    `GRAPHQL_*`, `~/.local/share/graphql*`, persisted `graphqlTools` fields) in one module, with no alias layer.
    The deployed cutover needs the owner's explicit go-ahead.
- **#51 SQL-text tests.** 135 files remain in `pendingSqlTextTests.mjs`. The owner allows running real-Postgres
  tests for these (local Postgres 16 is at `/usr/lib/postgresql/16/bin`). Convert them, run each, and shrink the
  list. Also run the earlier conversions that route fakes by call order or value count; the tracker names them.
  Branch `claude/arch-postgres-tests` has no commits.
- **Execution core.**
  - #13: finish the coordinator split and restore `private`.
  - #14: `workflowExecutionRequest`, `repeatPostgres` and `workflowLifecycle` still branch on handoffs.
  - #15: the web chat copies (2 conversation components, 3 composers, 5 streams).
  - #16: the remaining provider-name branches.
  - #20: about 50 inline queries in `repeatPostgres.ts`.
  - #21: `qualifyVerificationRuntime`.
- **Composition and data.**
  - #7: the per-harness allocation in the Operator manager factories.
  - #17: the remaining durable-write copies.
  - #25: one database-error → `DomainError` mapper, then drop the duplicated TypeScript checks.
  - #26: about 35 integration tests still use the begin/commit primitives.
- **Boundaries.**
  - #29: shrink the API (730 imports, 77 pairs) and web (97) pending lists.
  - #30 and #31: worker tests still import API files by path; the verification-runner package needs five copy lists
    changed together.
  - #32: two infrastructure imports remain, and `collaboration` vs `workflow-chat` needs a design decision.
  - #33: the Node-only contracts package; the plan is in the tracker.
- **CI split.**
  - #1: wire `HttpCiClient`, add the missing CI routes, and move `runs/activitiesSql` and
    `bug-reports/stuckExecutions` off the CI tables.
  - #2: Syncthing and Xvfb/Chromium into `HostAdministration`.
  - #3: migrate the byte-transfer callers in the order the tracker gives.
- **Smaller.**
  - #36: narrow `HarnessConfiguration` so the `=== 'opencode'` branches can go.
  - #49: drop Tailwind.
  - #22: proof types only where shapes truly match.
- **Won't do or kept:** #24 (owner decision), #28, and #4/#5 until CI is separate.


This is for the agent that continues the architecture cleanup. The goal is to fix every finding in
[`ARCHITECTURE-CLEANUP.md`](ARCHITECTURE-CLEANUP.md) as PRs, as fast as possible. A separate local integration agent
runs the tests, resolves conflicts and merges, so your job is to produce PRs. Read `AGENTS.md` first; it is binding.

## 1. State at handoff (2026-10-23)
> **Update:** #69–#78 are now merged into the integration branch, and the integration agent is fixing the test
> failures. Sections 1 and 3 below describe the earlier state; the owner decisions in the tracker replace the model
> and verification advice in section 2.

- **Integration branch:** `integration/browser-and-review-fixes`. #69 is merged into it. Every other PR targets it,
  either directly or stacked on #71.
- **Open PRs:** see the PR log in `ARCHITECTURE-CLEANUP.md`.
  - **Verified** (API tsc 0 errors, full lint passes): #70 (DB) and #71 (CI part 2a).
  - **Draft**, stopped early at the owner's request with typecheck and lint incomplete: #72 (CI 2b), #73 (web),
    #74 (tests), #75 (composition root), #76 (helpers), #77 (Operator MCP), #78 (execution core part 1).
  - Each PR body lists what was verified, what was not, the likely errors, the behaviour changes and the next steps.
- **Merge order:** #71 first, because #72, #74, #75, #76 and #77 are stacked on it. #70, #73 and #78 can go in any
  order.
- **Expected conflicts:**
  - `apps/api/src/production.ts`: #70, #75, #78.
  - `apps/api/src/modules/ci/platform.ts`: #70 vs #71. Keep #70's `withTransaction(pool, perform, { join })`.
  - `apps/api/test/**`: #74 renames about 190 files; it conflicts with #72, #75 and #77.
  - The #76 hash codemod makes one-line edits in about 147 files. When those conflict, take the other side and
    re-run `docs/handoffs/architecture-cleanup-tools/api-sha256-codemod.mjs` on the merged tree.

## 2. How to work (what worked here)
- **Parallel streams.** One git worktree per stream, branched from the integration branch, or stacked when a
  stream depends on an open PR. Give each stream explicit file ownership. Agents commit locally; the coordinator
  pushes and opens the PRs.
- **Models.** Mechanical work goes to Sonnet agents at high effort. Design work goes to Opus agents, which delegate
  bulk edits to at most two Sonnet helpers.
- **Heavy commands.** A full API `tsc --noEmit` takes about 3.5 min and 6–9 GB. On a 16 GB machine, serialise
  heavy commands through a lock:

  ```sh
  #!/bin/sh
  exec flock /path/to/.heavy.lock "$@"
  ```

  For example: `heavy.sh sh -c 'cd apps/api && node --max-old-space-size=9000 ./node_modules/typescript/bin/tsc --noEmit'`.
  eslint over `apps/api` also needs about 8 GB of heap.
- **Cheap checks** (no lock): `node scripts/check-import-cycles.mjs`, `check-package-boundaries.mjs`,
  `check-worker-imports.mjs`, `check-test-names.mjs`.
- **Local scripts.** Set `FOREMAN_CODE_CI_LOCAL=1` for any `pnpm typecheck|lint|test`. Without it they push a
  snapshot to Main's CI.
- **Builds.** Build contracts and ci before typechecking the API:
  `cd packages/contracts && ./node_modules/.bin/tsc -p tsconfig.build.json`, then the same in `apps/ci`.
- **Tests.** Don't run the suites; the integration agent does. Do write tests through public interfaces. Never add
  to `scripts/lint-allowlist.json`; fix the code, or use a list that may only shrink, as `pendingSqlTextTests.mjs`
  does.
- **Behaviour checks used for proof:**
  - `docs/handoffs/architecture-cleanup-tools/migration-hashes.mts`: the `(version, sha256(sql))` list must stay
    identical.
  - `dump-ci-tools.mts`: serialises the CI MCP tool definitions. Normalise the random UUIDs before diffing.
  - `app.printRoutes()` on a replay-mode production app: #75 shows how.

## 3. First jobs: finish the draft PRs
Run API and web `tsc` and eslint on each draft branch, fix what they report, and push. Each PR body names the likely
errors. In particular:
- **#72:** shifted `Parameters<>` indexes, port objects that need a `context`, the bound subclasses in
  `modules/ci/{mount,runner,runtime}.ts`; then run `pnpm --filter @foreman-code/ci test`.
- **#73:** typecheck commits 7–8 (outside-press hook, Board context split).
- **#74:** duplicate `helpers/database.js` imports, `begin/rollbackTransaction` argument types.
- **#75:** orphaned imports in `production.ts`.
- **#76:** `spawnProcess` overload typing.
- **#77:** the `tools/fileReferences.ts` fix is unverified.
- **#78:** eslint on #19/#23/#13/#21, and the 42 coordinator unit failures seen under a minimal vitest config. Compare
  them with base `01c2002` under the real config.

## 4. Remaining work, in a suggested order
Each item names a concrete next step. File and line references come from the audit, so re-read before editing.

1. **#6/#8/#11 Composition root (Opus).** Turn each `configure*` in `production.ts` into a `create*` factory that
   returns a typed object. Order the factories as the current calls are. Reach not-yet-built services through one
   callbacks accessor, and keep startup-time services in one typed `StartedServices` record. Then delete the
   `ProductionComposition` cast, the `!.` reads and the "not initialized" 503 guards (keep the codes tests assert).
   Do the same for `devices/installedWorkerDomains.ts`. Watch out: `new URL('../../../', import.meta.url)` gains one
   level in `src/composition/`.
2. **#7/#9 leftovers.** Move the native-manager resolver, launch credentials, chat/compaction logic and the artifact
   authorization SQL out of `production.ts`. Replace the `launchScopes`/`claudeLaunches` WeakMaps, the resolver
   function properties, the `jobRuntime.*.enrollment` assignments and the `registerApprovalCheckpointResume` setters.
3. **#40 Account detection (Sonnet plus a short design).** Write one `provider-accounts/accountStatus.ts` covering
   `computers/accountProbe.ts` (~97–204), `provider-accounts/localCredentials.ts` (~129) and
   `provider-accounts/nativeCommands.ts` (~198), and make the three callers use it.
4. **#42 Config.** About 90 `process.env` reads outside `config.ts`.
   - Pass-through environment for child processes should use `hostEnvironment()` (from #76).
   - Real reads move into `config.ts`: `CLAUDE_CONFIG_DIR`, `CODEX_HOME`, `FOREMAN_EXECUTION_RETRY_BACKOFF_MS`, the
     logger level, `HOME`/`DISPLAY`, the duplicated `HARNESS_WORKSPACE_ROOT` default, `readDeviceListenerConfig`.
   - Then add `no-restricted-properties` on `process.env`, allowing config, process, server, cli, production and
     tests.
5. **#16 Harness capabilities (Opus).** Add `capabilities.steer` / `.compact` to the harness port, and replace
   provider-name branching outside `harnesses/` with capability checks. Start with `qualifiedSteer` and
   `hasQualifiedSteer` in conversations.
6. **#15 rest (Opus).** Build a shared turn-execution core with per-side hooks for `runTurn`, observe/settle and
   recovery; it needs the DB integration tests. Then the web chat copies (#15 web part): `AgentConversation` vs
   `LiveAgentConversation`, 3 composers, 5 streams. The owner decides whether Agent and Operator prompt-rejection
   rules should match.
7. **#13 rest.** Extract the session lifecycle, reviewer/consultation and cancel/restart collaborators from
   `interactions/execution.ts`.
8. **#21 rest.** `runs/repeatRepositoryHost.ts` `openLocked`, `runs/workHandoffAdmission.ts` (~395),
   `jobs/verificationQualification.ts` (~73).
9. **#14 Repeat engine (Opus).** Only explicit finite repeat blocks should use repeat (AGENTS.md). Separate the
   hierarchy, handoff and repeat modes in `runs/repeatRuntime.ts` (~597) and `engine.ts`.
10. **#17/#20/#22.**
    - #17: replace the `runs/remote/operationJournal.ts` JSON-file database.
    - #20: move SQL from orchestration into repositories, e.g. `repeatPostgres.ts` `completeWorkRun` and the chat
      services' raw SQL.
    - #22: collapse the proof/verification/receipt layers.
11. **#18.** Drop the LangGraph `dist` patch (`patches/`) and the `PostgresSaver` subclass that uses internals
    (`infrastructure/checkpointMutations.ts`) once upstream offers the hooks, or wrap them behind one adapter.
12. **#26 rest.** Fold `ExclusiveGraphConnection` (~356 importers) into the one transaction API, in its own PR with
    integration coverage. Then the begin/commit sessions.
13. **#43 (decided and done in PR 9b).** The owner decided and the code now matches: the UI-only tools
    (`workflow_kanban_layout_get/_set`, `workflow_reorder`, `computers_maintenance_*`, `workspace_storage_folders_*`,
    `workspace_folder_undo/_rename`) are removed, `agent_defaults_get` and `workflow_create` left the core list,
    `operator_tool_schema_get` is merged into `tool_schema`, and a budget test bounds `tools/list`. Nothing is left to
    decide. The integration agent still has to run PR 9b and set the budget ceiling in
    `apps/api/test/operator-tool-registry.test.ts` to the measured size rounded up to the next 1,000 characters.
14. **#29/#32/#33 Boundaries.**
    - **Web.** Run `WEB_SRC=apps/web/src python3 docs/handoffs/architecture-cleanup-tools/web-feature-index-codemod.py --write`
      from the repo root; a dry run showed 347 imports convertible and 43 blocked by cycles. Confirm
      `node docs/handoffs/architecture-cleanup-tools/web-module-cycles.mjs` still shows only the 2 baseline cycles.
      Add `scripts/check-web-feature-boundaries.mjs` (with a list that may only shrink) to the web lint, and move
      shared graph/workflow-board leaves (`geometry`, `collaborationFields`, `signalEdge`, `nextDraft/state`,
      `workflow-board/context`, `keys`) into a neutral feature.
    - **API.** Write a module-level boundary checker (75 bidirectional pairs), then give modules public entry points.
    - **#33:** move the Node-only contracts code (`server-kit`, `installed-runtime-node`, `localClientNode`,
      `deviceIdentityNode`, the CI tooling) into a separate package.
15. **#46/#48/#49 web rest.** Move the Query-as-local-store uses (`useAgentChat` readbacks, `harnessSettings`) into
    Zustand; group `AgentSettingsForm`'s props; one styling system (the Kanban colours need tokens).
16. **#50/#51/#53/#54 tests rest.**
    - #51: shrink `pendingSqlTextTests.mjs` (229 files). Start with the 84 files that have 1–2 hits; many route on
      `from management_principals`, so a shared principal seam clears several at once.
    - #50: rename the ticket-named exported symbols (`agent3Database`, `seedAgent3`, `nim2691TaskDatabase`, `sch11*`,
      `br1002*`, `runEng03NativeScenario`), delete unused helpers, merge the DB fixtures.
    - #53/#54: `ENG03_A_TEST_DATABASE_URL`/`WAVE25_TEST_DATABASE_URL`; the flaky cases behind the 20 s default
      (`installedRuntimeQualification.test.ts`, `job-capabilities.test.ts`).
17. **#30 rest and #31.** The worker still imports about 40 `apps/api` modules. Give it package entry points. Move
    `captureVerificationInventory`/`finalizeVerification` out of `scripts/verification-runner.mjs` into a package
    that both the script and the API import.
18. **PR 4 Naming (do this late; it touches about 1,000 files).**
    - #34: codemod `@foreman-code/contracts/wave25` → `current` (decide one name for wave25/V3/Current);
      `interactions/wave25/`; comment codenames. Leave migration SQL and versions alone.
    - #35: rename graphql in code first. Deployed names (compose project, DB name, rsync path
      `~/.local/share/graphql-tools`, `~/.local/share/graphql/mcp`, `GRAPHQL_*` env) need a migration plan with the
      owner.
    - #36: remove `opencode` and `LegacyChatDeliveryBridge`.
    - #37: move ticket handoff docs under `docs/history/`.
19. **PR 12 CI as its own service/repo (last).**
    - Give CI its own schema; the CI migrations move with it. Some triggers write `run_activity`, so replace them
      with an event the product consumes.
    - Use an HTTP client instead of in-process ports, and a protocol package for `ci-*.mjs`.
    - #2: machine administration leaves the API. #3: one byte-transfer mechanism.
    - #4/#5 stay until then (owner decision).
20. **#24/#25 rest.** The migration squash/baseline needs a production copy; down migrations; move the duplicated
    SQL/TS rules to one side.

## 5. Keep the tracker current
Every PR updates `ARCHITECTURE-CLEANUP.md`: tick items, add a PR-log row, and record corrections to the audit.

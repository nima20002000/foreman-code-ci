# Architecture cleanup tracker

Tracks the architecture audit of this repository (55 findings, 2026-10-23) and the PRs that fix them.
Update this file in the same PR that changes an item's status: tick the box, add the PR to the log, and note any
finding that turned out to be wrong.

Legend: `[x]` done · `[~]` partly done (see note) · `[ ]` open · `[-]` won't do / wrong finding

## PR log
| # | PR | Scope | Status |
|---|----|-------|--------|
| 1 | nima20002000/foreman-code#69 | CI host → `apps/ci` package, server kit, package-boundary lint, wave-1 cleanups | merged into `integration/browser-and-review-fixes` |
| 2a | nima20002000/foreman-code#71 | CI part 2a: `jobs/ci*` + Circle accounts service → `apps/ci`, CI-owned routes/tools, worker dependency | open |
| 7 | nima20002000/foreman-code#70 | DB: one transaction helper, pools through the factory, one retry policy, migration version guard, PL/pgSQL map | open |
| 2b | — | CI part 2b: constructor injection replaces installed ports; CI tests move to `apps/ci` | planned |

## Owner decisions
- CI becomes its own product, but it keeps running exactly as today (`pnpm test → ci-remote → Main ci_run`, CircleCI
  and GitHub dispatch through mirrors, build-computer runner, release Clean-Round tickets).
- CircleCI stays reachable in the app while CI moves.
- CI scripts (`scripts/ci-*.mjs`, `ci-suite.sh`) and the contracts CI tooling are a protocol with the repo under
  test and stay at their paths until CI gets its own repo.
- New CI suite names need the deployed Main to know them first; tests join existing suites.
- Agent models: mechanical work (moves, import rewrites, renames, codemods, config plumbing) goes to Sonnet agents at
  high effort; design-heavy work (interfaces, cross-cutting refactors, reviews) goes to Opus agents.

## Corrections to the audit
- `hono` is not unused: `@modelcontextprotocol/node` needs it as a peer (`pnpm-lock.yaml`). Dropped.
- `features/agents/agentDirectoryStore.ts` is live through `AgentsDirectory`. `features/combined/` is a live router test.

## Findings by planned PR

### PR 2a: CI part 2, moves (in progress)
- [~] #1 CI system embedded in the product. `ci-host` moved to `apps/ci` (#69). 2a moved `jobs/ci*` (~20 files) and the
  Circle accounts service, and makes CI own its routes and MCP tool specs. Still left after 2a: 25 CI migrations
  (PR 12), non-CI SQL reading CI tables (`runs/agentCiSnapshot`, `computers/activity`), contracts CI tooling.
- [x] #30 (CI part) Worker declares `@foreman-code/ci` and imports CI by package name. The platform-install import from
  `apps/api` stays until 2b. The rest of #30 (other API modules in the worker) is open.
- [x] Integration coverage maps `apps/ci/dist` back to `apps/ci/src`.
- Done when: `apps/api/src/modules/jobs` has no CI files except `ciRuntimeContext.mjs`; routes/tools come from CI;
  boundary check green; tool names/schemas and route paths unchanged.

### PR 2b: CI part 2, injection and tests
- [ ] Replace the `environment.ts` service locator (installed ports) with constructor injection (`CiContext`).
- [ ] CI tests (~160) move to `apps/ci/test` and run in `unit-other`. Needs 2b's fakes, because today every test needs
  the API to install ports.
- Done when: `apps/ci` builds and tests without `apps/api`; a clean full round passes.

### Jobs verification (unscheduled)
- [ ] #31 Server imports `scripts/verification-runner.mjs`. After 2a, the API still imports
  `captureVerificationInventory` and `finalizeVerification` in `jobs/verification*`; `expectedPortions` reaches CI
  through a port. Move the shared logic into a package both the script and the API import.

### PR 3: Composition root
- [ ] #6 `production.ts` (3.2k lines) is a 147-field service-locator bag filled by 146 assignments, 23 `!.`.
- [ ] #7 Business logic, authorization and raw SQL inside the composition root.
- [ ] #8 Missing wiring surfaces as runtime 503s (25 guards).
- [ ] #9 Setter wiring hides cycles (`bindTarget` bound twice, `bindRouting`, `setRootPolicies`, WeakMap locator).
- [ ] #10 Routes registered in four places, some twice, some conditionally.
- [ ] #11 Second composition root inside `devices/installedWorkerDomains.ts`.
- [ ] #12 Test-mode branches in production wiring.
- Done when: no post-construction assignment, one route registry, route table unchanged.

### PR 4: Naming
- [ ] #34 Ticket/wave names in production: `contracts/wave25` (1,023 importers), `interactions/wave25/`,
  `pr17/pr18` migrations, `eng04_*` SQL, W07/W08/W09 comments; one version called wave25/V3/Current.
- [ ] #35 Unfinished graphql → foreman-code rename (646 files; compose/DB names, rsync path, env compat layer).
  Deployed names need a migration plan.
- [ ] #36 Retired `opencode` harness (156 refs), `LegacyChatDeliveryBridge`, 24 semantics-version guards.
- [ ] #37 Ticket-named docs (33 at `docs/` top level, PR review notes, stale ENG-04 handoff).
- Done when: `test-names` allowlist ≈ 0; no wave/ticket identifiers in `src`.

### PR 5: Duplicated helpers
- [ ] #38 43 raw spawns, 8 command wrappers, git run 5 ways with different safety flags.
- [ ] #39 Shelling out to Python/flock/getconf/`node -e` for basic operations.
- [ ] #40 Login/account detection in 3–4 places plus a separate CircleCI registry.
- [~] #41 Five DB-retry helpers (#70: one `databaseRetry.ts` policy module); 224 inline `createHash('sha256')` open.
- [ ] #42 Config: 136 direct `process.env` reads bypass `config.ts`.
- Done when: one module per concern, enforced by lint.

### PR 6: Module boundaries
- [~] #29 No module boundaries. CI↔API enforced (#69). Open: 75 bidirectional API module pairs; web 458 cross-feature
  imports (graph↔workflow-board cycle).
- [ ] #32 Layering inversions: infrastructure→modules (24), MCP builds services HTTP uses, `collaboration` duplicating
  `workflow-chat`.
- [~] #33 Contracts carries runtime code (`/proc`, credentials, CI tooling). #69 added `server-kit` there on purpose;
  split Node-only code into its own package.
- Done when: module-level boundary checker green for API and web.

### PR 7: Database
- [~] #24 (#70: registry overrides removed, version-order guard for new migrations; squash/down migrations open) 215 migrations as TS strings, mixed version formats, array order ≠ version order, registry overrides
  versions, single all-or-nothing transaction, no down migrations.
- [~] #25 (#70: `docs/architecture/database-functions.md` maps current definitions and duplicated rules; logic not moved) Domain logic in PL/pgSQL (244 functions, 186 triggers), functions redefined across migrations, rules in
  both SQL and TS.
- [~] #26 (#70: one `withTransaction`; delivery ALS made private; `ExclusiveGraphConnection` and begin/commit sessions open) Three transaction helpers + graph-connection framework + ambient `AsyncLocalStorage` client.
- [x] #27 (#70, lint rule `foreman/no-raw-database-pools`) Pools created outside the factory (~9 places).
- [-] #28 Schema still allows execution semantics 1/2. Won't do: `in (1,2,3)` keeps retained historical versions readable (AGENTS.md); new publications already require 3 by trigger.
- Done when: one transaction helper, pools only via factory, migration baseline verified on a prod copy.

### PR 8: Execution core (several PRs)
- [ ] #13 `ApprovalExecutionCoordinator` god class (3.7k lines, ~112 methods, 18-arg constructor).
- [ ] #14 "repeat" is the universal run engine despite AGENTS.md.
- [ ] #15 Two chat engines (agentChat/operatorChat) already drifting; web duplicates them too.
- [ ] #16 Leaky harness port (~36 optional members, 165 `'claude'`/`'codex'` checks outside harnesses).
- [ ] #17 `operationJournal` hand-rolled JSON DB; 2–3 sources of truth for run/CI state.
- [ ] #18 LangGraph patched in `dist` and subclassed via internals.
- [ ] #19 Run state machine only as string literals.
- [ ] #20 SQL mixed into orchestration; 201 of 237 query files aren't repositories.
- [ ] #21 400-line functions (`dispatchReview` 425).
- [ ] #22 Proof/verification/receipt sprawl (119 files, 17.5k lines).
- [ ] #23 Four routers for `execution-v1`.
- Done when: behavior tests unchanged; each sub-PR shrinks one item.

### PR 9: Operator MCP
- [ ] #43 203 tools (~28k description tokens; `workflow_save` 5.6k chars), layout/maintenance tools against AGENTS.md.
- Done when: owner-approved tool list.

### PR 10: Web
- [ ] #44 No single HTTP boundary (raw fetch ×4, XHR, 2nd client, 6 EventSources).
- [ ] #45 API shapes redefined locally (memory-boards ports, 46 `z.object`).
- [ ] #46 Seven hand-rolled storage outboxes; Query/Zustand used for each other's jobs.
- [~] #47 Dead code: `SelectedRunCanvas`, `TerminalPlaceholder` removed (#69). Open: legacy `GraphCanvas`/`GraphElements`/
  `JobNode` + `graph-scale.html`.
- [ ] #48 Board context with 34 fields, 36-prop form, `JSON.stringify` keys.
- [ ] #49 Three styling systems; Nocturne internals overridden in 39 files; 6 outside-click implementations.
- Note: base branch has 31 web type errors in chat-delivery files (pre-existing, not from cleanup PRs).

### PR 11: Tests
- [ ] #50 Tests outweigh source; 31k-line helper codebase importing 328 internal modules; 40 ticket-named helpers.
- [ ] #51 SQL-text fake databases (174 files) and SQL assertions the lint rule misses.
- [x] #52 Stale lint allowlist pruned 674 → 276 (#69).
- [~] #53 DB test gating: duplicate `postgresEnabled` removed (#69); five gating mechanisms remain.
- [ ] #54 Fragile release gates (9-hour live-production config, timeouts raised for flakiness, heavy phase).
- Done when: `no-source-text-tests` allowlist = 0.

### PR 12: CI as its own service/repo
- [ ] #2 Machine administration inside the API (apt upgrade, reboot, Syncthing, Xvfb/Chromium).
- [ ] #3 Five ways to move bytes between machines.
- [ ] #4 `pnpm test` runs through Main's CI (kept by owner decision until CI is separate).
- [ ] #5 Three CI systems (kept by owner decision).
- [ ] CI owns its schema (CI migrations move), HTTP client instead of in-process ports, protocol package for `ci-*.mjs`.

### Dropped
- [-] #55 `hono` unused: wrong, it is a required peer.

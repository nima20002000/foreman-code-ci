# Repository instructions

## Scope

This repository contains the React web shell in `apps/web`, the shared
contracts package in `packages/contracts`, and the Fastify/PostgreSQL workflow
engine in `apps/api`. The saved Website workflow can run real local Codex and
Claude harnesses. Do not add GraphQL transport or unrelated external
integrations unless the current workstream explicitly authorizes them.

Keep feature work behind the shared contracts package. The web app should not
redefine API/domain shapes locally or import server-only code.

## Current workflow execution semantics

All newly created executable workflows use execution semantics 3 through one
Board, shared save/read/Start services, and the same engine. `repeat` is absent
for ordinary workflows and configured only for explicit finite repeat blocks.
Retire active execution-semantics 1/2 paths and compatibility-only tests; fix
current consumers instead of restoring a legacy fallback. Preserve exact saved
WorkflowVersion and Run facts, and keep unrelated native, MCP, and graph protocol
version labels and historical ENG-03 evidence.

## Prototype permission model (owner decision)

Agents and the Operator may do whatever their work needs. The only ways to give an
Agent less power are limiting its MCP tools in the workflow or running it
read-only. About twenty approval steps, grants, caps, expiries and required
baselines were removed on purpose; their absence is not a bug. Never reintroduce
one, and never add new permission, approval or baseline paperwork, not even to
satisfy a review finding or a test. See
[`docs/adr/prototype-permission-model.md`](docs/adr/prototype-permission-model.md)
for the removed list and the real boundaries that stay.

## Operator MCP tools (keep them few and small)

Every tool's definition is sent to the model on every turn. The old "every capability ships an MCP tool" rule grew the
Operator MCP to 309 tools (~213k tokens), which overflowed Claude's context and made the Operator unusable. Do not
add an MCP tool just because the UI gained a feature.

- Add or change a tool only when the Operator needs it for real work the owner asks of it: creating and editing
  workspaces, workflows and Agents, running and inspecting work, and the settings the Operator manages. UI-only
  features (layout, views, display preferences, maintenance screens) get no tool.
- Prefer extending an existing tool over adding a new one; merge or remove tools nobody uses.
- Keep each tool small: a one- or two-sentence description and an input schema with only what a caller types. Never
  inline internal records (receipts, recovery closures, full configurations) as inputs; take an ID instead.
- Rarely used tools stay reachable through the discovery tools rather than the always-loaded core list. Watch the
  core list's size when adding to it.
- UI and MCP share contracts and domain services. A tool keeps grants, scope checks, validation, revision conflicts
  and idempotent retries, and never gives a read-only Agent write access.

## State and data ownership

- TanStack Query owns server state and request lifecycle state.
- Zustand owns local interaction state that is not shareable through the URL.
- The URL owns navigation, selected views, filters, and other linkable state.
- HTTP access must remain behind a small client boundary so MSW can provide
  deterministic request handlers in unit tests. The browser always uses the real API.

Do not duplicate one state source in another layer without a documented reason.

## UI/UX rules

- Dismissible modals close when the user clicks their backdrop, outside the modal. Clicks inside the modal and drags that start inside must not dismiss it. Use the shared Dialog behavior; preserve pending-operation locks and unsaved-change guards. Any exception must have a concrete interaction reason.

## Agent orchestration

- Send related changes and follow-up issues to the existing agent that owns the feature or workstream. Message a running agent or resume an idle agent; do not spawn a new agent for every related issue.
- Start a separate agent for distinct work, an explicitly requested separate assignment, or an independent review. Preserve clear ownership when coordinating shared files.

## Releases

- No release without one clean full round on the release commit's code: typecheck, lint, unit and integration,
  all with full scope and every part passed, on the exact commit the release builds on. A failed or affected-scope
  round blocks the release; fix and run a new full round.
- The round runs through Foreman CI, not locally. Release only with `corepack pnpm release <X.Y.Z>`
  (`scripts/release.mjs`), which records the passing tickets in the commit's `Clean-Round` trailers. Deployers
  verify a release commit with `node scripts/verify-release-round.mjs <commit>` before deploying it.

## Verification

From the repository root, use the pinned pnpm runtime. Plain npm installs are
blocked because they bypass the strict 48-hour package-release-age policy.
Run:

```sh
corepack pnpm install
corepack pnpm typecheck
corepack pnpm lint
corepack pnpm test
corepack pnpm build
corepack pnpm db:up
corepack pnpm test:integration
corepack pnpm test:acceptance
corepack pnpm db:down
```

Tests assert behavior through public interfaces: rendered UI, HTTP and MCP
responses, function results, and persisted data. Tests that check source text,
file hashes, file paths, SQL strings, private members, or implementation
wording are not contracts. Replace them with behavior tests or delete them;
never keep or add slop to satisfy them. Never skip, weaken, or delete a test to
get a green run. A removed test needs a replacement that covers the same
behavior.

Every bug fix ships its own regression test, through a public interface, that
fails on the code before the fix and passes after it. Show the failing run on
the pre-fix commit before merging the fix.

Keep generated output, local environment files, caches, and credentials out of
Git. Make focused changes and preserve unrelated worktree edits.

## Lint rules

Every package lint enforces these as errors (local rules live in
`scripts/eslint-plugin-foreman`). Files, test names and cycles listed in
`scripts/lint-allowlist.json` predate a rule; never add to that list, fix the
code instead. Exemptions use content IDs so unchanged renames keep their exemptions, including in the cloud mirror.
Editing an exempt file requires fixing its violations. `node scripts/lint-baseline.mjs` prunes entries that pass.

- `foreman/no-source-text-tests`: tests may not read repository source files
  or `?raw` imports, or assert on SQL/query/statement text. See above.
- `foreman/no-local-canonical-json`: one shared canonical JSON module
  (`canonicalJson`), so hashes and comparisons agree everywhere.
- `foreman/no-raw-transactions`: `BEGIN`/`COMMIT`/`ROLLBACK` only through the
  shared transaction helper, which handles release and rollback failures.
- `foreman/no-silent-catch`: no empty `catch` or `.catch(() => {})`; log or
  handle the error, or explain with a comment starting `ignore:`.
- `foreman/no-legacy-execution-semantics`: no branches on execution
  semantics 1 or 2 (see above).
- `foreman/test-timeout-limit`: unit test and hook timeouts in `src/` stay at
  or below 30 s; slow work belongs in integration tests.
- `scripts/check-import-cycles.mjs` (API lint): no runtime import cycles in
  `apps/api/src`; move shared code into a module both sides import.
- `scripts/check-api-module-boundaries.mjs` (API lint): a module under
  `apps/api/src/modules/` imports another module only through its `index.ts`,
  and two modules never import each other. Violations that predate the check
  are in `scripts/api-module-boundaries-pending.mjs`; that list only shrinks
  (`--prune` removes fixed lines).
- `scripts/check-test-names.mjs` (API lint): name test files after behavior,
  not tickets, waves, lanes, rounds or agents (`eng04-`, `pr17-`, `w08-`).

======
## 1. Think Before Coding

**Don't assume. Don't hide confusion. Surface tradeoffs.**

Before implementing:
- State your assumptions explicitly. If uncertain, ask.
- If multiple interpretations exist, present them - don't pick silently.
- If a simpler approach exists, say so. Push back when warranted.
- If something is unclear, stop. Name what's confusing. Ask.

## 2. Simplicity First

**Minimum code that solves the problem. Nothing speculative.**

- No features beyond what was asked.
- No abstractions for single-use code.
- No "flexibility" or "configurability" that wasn't requested.
- No error handling for impossible scenarios.
- If you write 200 lines and it could be 50, rewrite it.

Ask yourself: "Would a senior engineer say this is overcomplicated?" If yes, simplify.

## 3. Surgical Changes

**Touch only what you must. Clean up only your own mess.**

When editing existing code:
- Don't "improve" adjacent code, comments, or formatting.
- Don't refactor things that aren't broken.
- Match existing style, even if you'd do it differently.
- If you notice unrelated dead code, mention it - don't delete it.

When your changes create orphans:
- Remove imports/variables/functions that YOUR changes made unused.
- Don't remove pre-existing dead code unless asked.

The test: Every changed line should trace directly to the user's request.

## 4. Goal-Driven Execution

**Define success criteria. Loop until verified.**

Transform tasks into verifiable goals:
- "Add validation" → "Write tests for invalid inputs, then make them pass"
- "Fix the bug" → "Write a test that reproduces it, then make it pass"
- "Refactor X" → "Ensure tests pass before and after"

For multi-step tasks, state a brief plan:
```
1. [Step] → verify: [check]
2. [Step] → verify: [check]
3. [Step] → verify: [check]
```

Strong success criteria let you loop independently. Weak criteria ("make it work") require constant clarification.

---

**These guidelines are working if:** fewer unnecessary changes in diffs, fewer rewrites due to overcomplication, and clarifying questions come before implementation rather than after mistakes.

PROJECT RULE: YOU ARE NOT ALLOWED TO CHANGE SSH/VPS SECURITY/ ROUTER SETTINGS UNLESS I SPECIFICALLY GIVE YOU PERMISSION FOR THE JOB YOU WANT TO DO

PROJECT RULE: DO NOT USE LINEAR OR CREATE, UPDATE, OR COMMENT ON LINEAR ISSUES UNLESS THE USER SPECIFICALLY ASKS YOU TO USE LINEAR FOR THE CURRENT TASK.

PROJECT RULE: IF THE USER ASSIGNS AN AGENT AS THE ORCHESTRATOR FOR A LINEAR-GOVERNED WORKSTREAM, THAT ORCHESTRATOR MUST READ AND FOLLOW THE CURRENT LINEAR PLAN AND ISSUES FOR PHASE ORDER, AGENT ROLES AND PARALLEL COUNTS, DEPENDENCIES, OWNERSHIP, AND REVIEW/TEST/FIX GATES. DO NOT INVENT, SPLIT, COMBINE, SERIALIZE, OR REORDER THE SPECIFIED LANES OR STEPS. APPLY THE USER'S LATER EXPLICIT CHANGES TO THE PLAN. THIS RULE APPLIES ONLY TO THE ORCHESTRATOR; IT DOES NOT AUTHORIZE OTHER AGENTS TO USE LINEAR OR ANY AGENT TO WRITE TO LINEAR WITHOUT THE USER'S TASK-SPECIFIC REQUEST.

PROJECT RULE: WHEN THE USER ASKS FOR CLARIFICATION, QUESTIONS A PREMISE, OR APPEARS CONFUSED, VERIFY THE RELEVANT FACTS AND ANSWER DIRECTLY BEFORE TAKING A NEW ACTION INFERRED FROM THAT QUESTION. A QUESTION IS NOT A FINAL INSTRUCTION TO CHANGE COURSE. DISTINGUISH VERIFIED RESULTS FROM AGENT CLAIMS AND UNFINISHED WORK; CORRECT A MISTAKEN PREMISE INSTEAD OF GUIDING THE USER DOWN THE WRONG PATH. THEN CONTINUE WORK THAT WAS ALREADY AUTHORIZED AND DOES NOT DEPEND ON THE CLARIFICATION.

PROJECT RULE: DO NOT WORK AROUND SECURITY OR SANDBOX LIMITS BY ADDING TOOLS, WRITABLE PATHS, BYPASSES, OR OTHER ESCAPE HATCHES. A READ-ONLY AGENT MUST REMAIN READ-ONLY. FIND AND FIX THE UNDERLYING CONFIGURATION OR PRODUCT CONTRACT THAT CAUSED THE FAILURE, EVEN FOR A TEST SCENARIO. WHEN A TASK LEGITIMATELY REQUIRES BROADER ACCESS, EXPOSE AND USE THE HARNESS'S EXPLICIT SECURITY SETTING FOR THAT PARTICULAR AGENT INSTEAD OF HIDING THE SYMPTOM.

PROJECT RULE: For browser interaction in this application, use the built-in computer-use tool. Do not use Browser Use, agent-browser, or isolated-browser tooling unless the user explicitly requests it for the current task. Work in the existing app tab when appropriate; do not create a separate browser environment on your own initiative.

PROJECT RULE: This application is in a local demo phase. The local application database and browser-authentication records are disposable and may be reset, recreated, or deleted when needed to bring up and test the app interface. This authorization does not extend to unrelated local data, external services, production data, SSH/VPS security, or router settings.

PROJECT RULE: Worktree cleanup is the orchestrator's responsibility and part of task completion. Once a worktree's work is complete and integrated into its destination branch, merged into main, or otherwise finished and safely retained, the orchestrator must promptly remove the unused worktree with `git worktree remove` and run `git worktree prune` to free disk space. Before removal, verify that no active agent or process still needs it, preserve any unintegrated or uncommitted work, and retain required evidence. Do not leave completed worktrees accumulating as an optional follow-up.

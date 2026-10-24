# Board UX findings after one-board

Rechecked all 16 findings from the original Board structural UX audit against
`a73fb242c5` on `fix/uxfix-board`, including the one-board review and its fixes.
No pages, permission steps, API contracts or historical WorkflowVersion/Run facts
were added or changed. Graph and Overview retain the same Board and edit owner.

- **BOARD-01: Fixed in 6cbc8a0568.** Runs-menu inspection navigation now receives the same snapshot-verified Run scope used to render its controls.

- **BOARD-02: Fixed in 6cbc8a0568.** The retained live Graph already kept its inbox; the shared native inbox trigger and pending count now also appear in Overview and saved Run controls.

- **BOARD-03: Fixed in 6cbc8a0568.** Historical toolbar Start names the current workflow and displays its saved version and new-input policy; the existing full retry remains pinned to the selected Run and its accepted input.

- **BOARD-04: Fixed in dc66b04e5d.** Action errors, validation alerts, undo feedback and Start/Save recovery now use the existing visible authoring panel host alongside the persistent toolbar and settings in Graph and Overview.

- **BOARD-05: Fixed in 6cbc8a0568.** Saved Settings renders the immutable node and pinned Agent configuration plus Edit current workflow, retaining the selected node without modifying Run facts.

- **BOARD-06: Fixed in 6cbc8a0568.** The historical node inspector mounts independently of canvas visibility, retaining expanded exact results in Overview.

- **BOARD-07: Fixed in 2754a1719c.** Accepted the review dispute. Node Details and Activities reuse repetition controls, exact accepted-value evidence and predecessor/result bindings, carry the same node/repetition/attempt through their URL selection, and offer direct transitions; live polling and explicit history refresh stay distinct.

- **BOARD-08: Fixed in 94a85146f7.** Saved connections retain their immutable handoff-limit button and open relationship-filtered execution/binding evidence with existing Run handoff usage.

- **BOARD-09: Fixed in 6cbc8a0568.** The primary Runs menu continues beyond 250 records through a ten-page sliding window, with a Newest runs action; its history cache cannot evict the separate latest-Run overlay read.

- **BOARD-10: Fixed in 6cbc8a0568.** When draft changes are pending, Overview explicitly names its current-saved-workflow scope and offers Review draft changes; no draft or historical facts are substituted.

- **BOARD-11: Resolved by one-board (a73fb242c5).** The one-board base already contains 8d258d530d: invalid selection retains WorkspaceSelection navigation and exposes Open workflows and Clear invalid selection. This repair predates the one-board commits.

- **BOARD-12: Resolved by one-board (a73fb242c5).** The one-board base already contains 236b2d34dc: BoardNavigationControls no longer sets Files readOnly and the popover labels current reference files. This repair predates the one-board commits.

- **BOARD-13: Fixed in 6cbc8a0568.** Historical floating-panel headings receive the selected snapshot node name, including nodes renamed or removed in the current workflow.

- **BOARD-14: Fixed in d15278a105.** Attempt history adds Newest attempts to cancel any in-flight read and reset to a fresh first page after eviction or new arrivals; retry uses the same reset. The latest-attempt poll and bounded history remain separate.

- **BOARD-15: Fixed in 6cbc8a0568.** Workflow-related schedule rejections offer Review workflow through the existing dirty/pending guard, returning to current workflow settings.

- **BOARD-16: Fixed in 6cbc8a0568.** Ordinary View Run clicks close Schedule through its existing guard and use the Board Run-selection callback; standard modified link gestures still work.

## Regression evidence

All checks use Foreman CI; no tests, typecheck, lint or builds were run locally.

- `361bdb08b0be631bf382b3cc82f7689cd3f1282a`: test-only pre-fix snapshot.
  `c0cf4b53-c4eb-48d8-98bc-1b6640240484` failed 11 cases;
  `7e110122-84d6-424f-98f0-d4d010196b2e` failed the saved-connection case
  while its other 21 route tests passed.
- `73691d47f093529e7fb4e8159e50f4d50ff1cd40`: test-only Start-target regression.
  `13514584-975f-465e-9f51-abda6d176e7d` failed all four terminal-state cases.
- `f073c12e511b5d56f3b0601121f657bbc769cd0a`: test-only corrected rename fixture.
  `d5c8ce2c-57b0-4a93-840e-be43df9e602d` failed all seven structural cases,
  including the historical heading after an actual current-node rename.

Rendered UI tests use real Board/router/Query components with MSW at the HTTP
boundary. Existing live-lock and save/recovery checks now find workflow actions
in the persistent Board toolbar; canvas assertions still target the canvas.
Schedule fixtures use the shared occurrence identity, and the Overview test
expands its accepted-results disclosure before checking continued visibility.

The first post-fix round exposed an inherited React Flow pointer-events lock on
the saved connection button (`729dda96-4ab4-4d38-acc7-0df54906aa0d`, at
`b3e4dd5748`). Its user-click regression remained unchanged; `f9097f9c4b`
explicitly enables pointer interaction on that inspection target.

At `b3e4dd5748`, the focused structural/schedule/approval/save group
`748841ff-53b6-46b4-ad92-e0aa8a047c9d` passed all 42 tests and live-lock ticket
`75133972-747e-4397-87b6-4e8519eeb2c4` passed all nine tests.

At `e5dd373ccf`, tickets `0469e918-4b8e-4be3-a647-45d593115457` and
`cb725c79-4629-470e-b087-2a6861178be8` passed all 148 fast tests.
Heavy ticket `26fdc080-3ecc-448b-b1a9-5fa7c5a569b5` passed 112 tests and
exposed the remaining connection visibility defect: the correct relationship
was selected inside a collapsed Run-details disclosure. `94a85146f7` reveals
that existing disclosure on relationship selection without controlling later
manual disclosure state. The unchanged route regression asserts visibility.

## Review follow-up regression evidence

The follow-up accepts the BOARD-07 dispute and repairs BOARD-04/NEW-01 and
BOARD-14/NEW-02. The other thirteen dispositions are unchanged.

Test-only commit `1fb9f998332faeb97922bc083b900153f3ab58d9` failed all six new
rendered UI regressions in Foreman CI ticket `90f37ce9-97eb-4b73-9a74-a50716b68bb2`;
the seventeen existing schedule tests passed. The earlier test-only commit
`6fce7cae1f0f7061bf78c748899d2ea117cc1d1a` also failed six cases in
`2b54fee8-0bcc-4377-822c-9d8618965bb5`; the second test commit corrects the Start
message and field-label expectations before any product repair.

The new tests cover visible Overview Start rejection and reload, Save validation
and field/alert recovery, six-page schedule eviction and newest reset, newly
arrived history with unsaved schedule edits, node repetition/binding inspection,
and exact execution navigation between node Details and Activities.

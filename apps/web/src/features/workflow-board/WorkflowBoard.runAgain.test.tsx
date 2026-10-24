// @vitest-environment jsdom
import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it } from 'vitest'
import { CurrentRunDetailsSchema, RepeatGraphCurrentStateSchema, RunStartCurrentInputSchema } from '@foreman-code/contracts/current'
import { nextDraftKey } from '../board-core'
import { useGraphDraftStore } from '../graph'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { boardHref, installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard, type InspectionFixture } from './eng05D.testSupport'

installBoardTestLifecycle()
let fixture: InspectionFixture, serial = 0
beforeEach(async () => {
  fixture = await inspectionBoardFixture(`run-again-${++serial}`)
  fixture.mock.controls.start = true
})

function selectState(executionState: 'completed' | 'interrupted' | 'queued' | 'running' | 'waiting',
  outcome: 'succeeded' | 'failed' | 'canceled' | 'pending', cleanupPending = false) {
  const { scope } = fixture.runs.before
  const detail = fixture.mock.runs.get(scope.runId)!
  fixture.mock.runs.set(scope.runId, CurrentRunDetailsSchema.parse({ ...detail, cleanupPending,
    run: { ...detail.run, executionState, outcome, result: executionState === 'completed'
      ? { outcome, ...(outcome === 'failed' ? { error: { code: 'TEST_FAILED', message: 'Failed Run', retryable: false } } : {}) } : undefined,
      finishedAt: executionState === 'completed' ? detail.run.finishedAt : undefined } }))
  const current = fixture.mock.currents.get(scope.runId)!
  fixture.mock.currents.set(scope.runId, RepeatGraphCurrentStateSchema.parse({ ...current,
    state: { ...current.state, run: { ...current.state.run, executionState, outcome, cleanupPending } } }))
  return scope
}

it.each([
  ['completed', 'completed', 'succeeded'], ['failed', 'completed', 'failed'],
  ['stopped', 'completed', 'canceled'], ['interrupted', 'interrupted', 'pending'],
] as const)('starts the saved workflow from a %s Run graph', async (_label, state, outcome) => {
  const scope = selectState(state, outcome)
  const original = structuredClone(fixture.mock.runs.get(scope.runId))
  measureBoardWire(fixture.mock)
  const mounted = await mountMeasuredBoard(`${boardHref(scope)}&boardView=graph`)
  await screen.findByRole('region', { name: 'Selected Run board' })
  const toolbar = within(await screen.findByRole('banner', { name: 'Board toolbar' }))
  const run = await toolbar.findByRole('button', { name: 'Start saved version' })
  await waitFor(() => expect(run, run.title).toBeEnabled())
  expect(run).toHaveTextContent('Run')
  expect(toolbar.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  await userEvent.setup().click(run)
  await waitFor(() => expect(fixture.mock.runs.size).toBe(4))
  const starts = fixture.mock.calls.filter(call => call.method === 'POST' && call.path.endsWith('/runs'))
  expect(starts).toHaveLength(1)
  expect(RunStartCurrentInputSchema.parse(starts[0]!.body)).toMatchObject({
    workspaceId: scope.workspaceId, workflowId: scope.workflowId, workflowVersionId: fixture.after.id,
  })
  expect(fixture.mock.runs.get(scope.runId)).toEqual(original)
  // The generic Start fixture has a fixed old clock; this newly admitted Run starts after history.
  fixture.mock.runs.get('run-current-1')!.run.startedAt = new Date(Date.parse(fixture.after.createdAt) + 1000).toISOString()
  await mounted.cache.invalidateQueries()
  expect(await screen.findByRole('region', { name: 'Workflow authoring' })).toBeVisible()
  expect(mounted.router.state.location.search).not.toHaveProperty('selectedRunId')
  expect(mounted.router.state.location.search).not.toHaveProperty('runId')
  expect(screen.queryByRole('region', { name: 'Selected Run board' })).not.toBeInTheDocument()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled())
}, 15_000)

it.each(['queued', 'running', 'waiting'] as const)('keeps Stop for a %s Run', async state => {
  const scope = selectState(state, 'pending')
  measureBoardWire(fixture.mock)
  await mountMeasuredBoard(`${boardHref(scope)}&boardView=graph`)
  const toolbar = within(await screen.findByRole('banner', { name: 'Board toolbar' }))
  await waitFor(() => expect(toolbar.getByRole('button', { name: 'Stop' })).toBeEnabled())
  expect(toolbar.queryByRole('button', { name: 'Start saved version' })).not.toBeInTheDocument()
})

it('keeps the draft save action when a finished Run has unsaved workflow edits', async () => {
  const scope = selectState('completed', 'succeeded')
  const wire = measureBoardWire(fixture.mock)
  await mountMeasuredBoard(`${boardHref(scope)}&boardView=graph`)
  const key = nextDraftKey(scope.workspaceId, scope.workflowId)
  await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]).toBeDefined())
  act(() => useGraphDraftStore.getState().changeNextDraft(key, graph => ({ ...graph, name: 'Unsaved name' })))
  const toolbar = within(await screen.findByRole('banner', { name: 'Board toolbar' }))
  expect(await toolbar.findByRole('button', { name: 'Save and run' })).toHaveTextContent('Save and run')
  expect(toolbar.queryByRole('button', { name: 'Stop' })).not.toBeInTheDocument()
  expect(wire.writes()).toHaveLength(0)
}, 15_000)

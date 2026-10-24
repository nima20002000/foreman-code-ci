import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it } from 'vitest'
import { readRunInspectionKey } from '@foreman-code/contracts/current'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { boardHref, installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard, setRunState, type InspectionFixture } from './eng05D.testSupport'

installBoardTestLifecycle()
let fixture: InspectionFixture, serial = 0
beforeEach(async () => { fixture = await inspectionBoardFixture(`node-continuity-${++serial}`) })
const href = () => `${boardHref(fixture.runs.repeated.scope)}&boardPanel=agent&boardNodeId=${fixture.second.id}&boardAgentTab=details&boardExecutionId=${fixture.repeatedExecutions[2]!.detail.execution.executionId}`

it.each([false, true])('opens current workflow Details without selecting history (live Run: %s)', async live => {
  measureBoardWire(fixture.mock)
  if (live) setRunState(fixture, fixture.runs.after.scope, 'running')
  const { router } = await mountMeasuredBoard(`/workspaces/${fixture.mock.workspaceId}?workflowId=${fixture.after.workflowId}`)
  const user = userEvent.setup()
  const editor = await screen.findByRole('region', { name: 'Workflow authoring' })
  await user.click(await within(editor).findByRole('button', { name: `Open ${fixture.first.name} information` }))
  const panel = await screen.findByRole('complementary', { name: 'Workflow side panel' })
  expect(await within(panel).findByText('Starts workflow')).toBeVisible()
  if (live) {
    const execution = fixture.mock.inspection.get(fixture.runs.after.run.id)![0]!.detail.execution
    await user.click(await within(panel).findByRole('button', { name: `Attempt ${execution.attempt} · ${execution.executionId}` }))
    expect(await within(panel).findByRole('article', { name: `Execution ${execution.executionId}` })).toBeVisible()
    expect(router.state.location.search).toMatchObject({ boardRunId: fixture.runs.after.run.id, boardExecutionId: execution.executionId })
  }
  expect(router.state.location.search.runId).toBeUndefined()
  expect(router.state.location.search.selectedRunId).toBeUndefined()
  expect(router.state.location.search.runNodeId).toBeUndefined()
  expect(screen.getByRole('region', { name: 'Workflow authoring' })).toBe(editor)
  expect(editor).toBeVisible()
  expect(screen.queryByText('Invalid board selection')).not.toBeInTheDocument()
}, 15_000)

it('filters node Details by business repetition and reads its exact predecessor bindings', async () => {
  measureBoardWire(fixture.mock)
  const { router } = await mountMeasuredBoard(href()), user = userEvent.setup()
  const panel = await screen.findByRole('complementary', { name: 'Workflow side panel' })
  const detail = fixture.repeatedExecutions[3]!.detail
  const repetition = await within(panel).findByRole('combobox', { name: 'Business repetition' })
  await waitFor(() => expect(within(repetition).getByRole('option', { name: new RegExp(detail.execution.occurrence!.occurrenceId) })).toBeInTheDocument())
  await user.selectOptions(repetition, detail.execution.occurrence!.occurrenceId)
  await waitFor(() => expect(within(panel).getAllByRole('button', { name: /^Attempt / })).toHaveLength(1))
  await user.click(within(panel).getByRole('button', { name: `Attempt 1 · ${detail.execution.executionId}` }))
  await within(panel).findByLabelText(`Accepted result ${detail.execution.executionId}`)
  await user.click(within(panel).getByText('Exact predecessor/result bindings', { selector: 'summary' }))
  expect(await within(panel).findByLabelText(`Binding ${fixture.repeatedExecutions[3]!.bindings[0]!.bindingId}`)).toBeVisible()
  expect(readRunInspectionKey(router.state.location.search.runExchangeKey)).toEqual({
    occurrenceId: detail.execution.occurrence!.occurrenceId, executionId: detail.execution.executionId,
  })
}, 15_000)

it('carries the exact node, repetition and attempt between Details and Activities without rediscovery', async () => {
  measureBoardWire(fixture.mock)
  const { router } = await mountMeasuredBoard(href()), user = userEvent.setup()
  const panel = await screen.findByRole('complementary', { name: 'Workflow side panel' })
  const original = fixture.repeatedExecutions[2]!.detail
  await within(panel).findByLabelText(`Accepted result ${original.execution.executionId}`)
  await user.click(within(panel).getByRole('button', { name: 'Inspect in Activities' }))
  const history = await screen.findByRole('region', { name: 'Exact execution inputs and results' })
  expect(await within(history).findByLabelText(`Accepted result ${original.execution.executionId}`)).toBeVisible()
  expect(within(history).getByRole('combobox', { name: 'Business repetition' })).toHaveValue(original.execution.occurrence!.occurrenceId)
  const next = fixture.repeatedExecutions[1]!.detail
  await user.click(within(history).getByRole('button', { name: new RegExp(next.execution.executionId) }))
  const exact = await within(history).findByRole('article', { name: `Execution ${next.execution.executionId}` })
  await user.click(within(exact).getByRole('button', { name: 'Open node Details' }))
  expect(await within(panel).findByRole('article', { name: `Execution ${next.execution.executionId}` })).toBeVisible()
  expect(within(panel).getByRole('combobox', { name: 'Business repetition' })).toHaveValue(next.execution.occurrence!.occurrenceId)
  expect(within(panel).getByRole('region', { name: 'Agent output and artifacts' })).toBeVisible()
  expect(readRunInspectionKey(router.state.location.search.runExchangeKey)).toEqual({
    occurrenceId: next.execution.occurrence!.occurrenceId, executionId: next.execution.executionId,
  })
  expect(screen.getAllByTestId('unified-workflow-board')).toHaveLength(1)
}, 15_000)

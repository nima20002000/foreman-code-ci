import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it } from 'vitest'
import { readRunInspectionKey } from '@foreman-code/contracts/current'
import { useGraphDraftStore } from '../graph'
import { nextDraftKey } from '../board-core'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { boardHref, installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard, openRunDetails,
  type InspectionFixture } from './eng05D.testSupport'

installBoardTestLifecycle()
let fixture: InspectionFixture, serial = 0
beforeEach(async () => { fixture = await inspectionBoardFixture(`board-ux-${++serial}`) })
const currentHref = () => `/workspaces/${fixture.mock.workspaceId}?workflowId=${fixture.after.workflowId}`

it('navigates node, repetition, attempt and clear filters from the normal Runs selection', async () => {
  const owner = fixture.runs.repeated, user = userEvent.setup()
  measureBoardWire(fixture.mock)
  const { router } = await mountMeasuredBoard(`${currentHref()}&selectedRunId=${owner.run.id}`)
  const inspector = await openRunDetails()
  await user.selectOptions(within(inspector).getByRole('combobox', { name: 'Run node' }), fixture.second.id)
  await waitFor(() => expect(router.state.location.search.runNodeId).toBe(fixture.second.id))
  const detail = fixture.repeatedExecutions[2]!.detail
  const occurrenceId = detail.execution.occurrence!.occurrenceId
  await user.selectOptions(within(inspector).getByRole('combobox', { name: 'Business repetition' }), occurrenceId)
  await user.click(await within(inspector).findByRole('button', { name: new RegExp(detail.execution.executionId) }))
  await within(inspector).findByLabelText(`Accepted result ${detail.execution.executionId}`)
  expect(readRunInspectionKey(router.state.location.search.runExchangeKey)).toEqual({ occurrenceId, executionId: detail.execution.executionId })
  await user.click(within(inspector).getByRole('button', { name: 'Clear detail filter' }))
  await waitFor(() => expect(router.state.location.search.runNodeId).toBeUndefined())
  expect(router.state.location.search.selectedRunId).toBe(owner.run.id)
}, 15_000)

it('keeps draft actions, settings and the native inbox available in Overview', async () => {
  measureBoardWire(fixture.mock)
  await mountMeasuredBoard(currentHref())
  const key = nextDraftKey(fixture.mock.workspaceId, fixture.after.workflowId)
  await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]).toBeDefined())
  act(() => useGraphDraftStore.getState().changeNextDraft(key, graph => ({ ...graph, name: 'Unsaved Board name' })))
  await userEvent.click(screen.getByRole('button', { name: 'Overview' }))
  expect(await screen.findByRole('button', { name: 'Save and run' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Save workflow' })).toBeVisible()
  expect(screen.getByRole('button', { name: 'Undo' })).toBeVisible()
  expect(screen.getByRole('button', { name: /Open human approval inbox/ })).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Workflow settings' }))
  expect(await screen.findByRole('complementary', { name: 'Workflow settings' })).toBeVisible()
}, 15_000)

it('keeps the existing native approval inbox reachable on a saved Run', async () => {
  measureBoardWire(fixture.mock)
  await mountMeasuredBoard(boardHref(fixture.runs.before.scope))
  await userEvent.click(await screen.findByRole('button', { name: /Open human approval inbox/ }))
  expect(await screen.findByRole('dialog', { name: /Approval inbox/i })).toBeVisible()
}, 15_000)

it('shows immutable saved Settings with a direct transition to edit the same current node', async () => {
  const owner = fixture.runs.before
  measureBoardWire(fixture.mock)
  const { router } = await mountMeasuredBoard(`${boardHref(owner.scope)}&boardPanel=agent&boardNodeId=${fixture.first.id}&boardAgentTab=settings`)
  const settings = await screen.findByRole('region', { name: 'Saved Agent settings' })
  expect(await within(settings).findByLabelText('Saved Agent configuration')).toHaveTextContent(owner.version.agentConfigurationVersionIds[fixture.first.agentId]!)
  expect(within(settings).getByLabelText('Saved node settings')).toHaveTextContent(fixture.first.id)
  await userEvent.click(within(settings).getByRole('button', { name: 'Edit current workflow' }))
  await waitFor(() => expect(router.state.location.search.runId).toBeUndefined())
  expect(router.state.location.search).toMatchObject({ boardNodeId: fixture.first.id, boardAgentTab: 'settings' })
}, 15_000)

it('retains exact execution Details in Overview', async () => {
  const owner = fixture.runs.before, detail = fixture.ordinaryExecutions[1]!.detail
  measureBoardWire(fixture.mock)
  await mountMeasuredBoard(`${boardHref(owner.scope)}&boardPanel=agent&boardNodeId=${fixture.first.id}&boardAgentTab=details&boardExecutionId=${detail.execution.executionId}`)
  const rail = await screen.findByRole('complementary', { name: 'Workflow side panel' })
  await within(rail).findByLabelText(`Accepted result ${detail.execution.executionId}`)
  await userEvent.click(screen.getByRole('button', { name: 'Overview' }))
  expect(await within(rail).findByLabelText(`Accepted result ${detail.execution.executionId}`)).toBeVisible()
}, 15_000)

it('labels saved Overview scope while offering a return to unsaved draft changes', async () => {
  measureBoardWire(fixture.mock)
  const { router } = await mountMeasuredBoard(currentHref())
  const key = nextDraftKey(fixture.mock.workspaceId, fixture.after.workflowId)
  await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]).toBeDefined())
  act(() => useGraphDraftStore.getState().changeNextDraft(key, graph => ({ ...graph, name: 'Pending hierarchy work' })))
  await userEvent.click(screen.getByRole('button', { name: 'Overview' }))
  expect(await screen.findByText('Overview shows the current saved workflow. Unsaved Board changes are not shown.')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Review draft changes' }))
  await waitFor(() => expect(router.state.location.search.boardView).toBe('graph'))
  expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.name).toBe('Pending hierarchy work')
}, 15_000)

it('uses the saved node name for historical panel headings after a current rename', async () => {
  const current = fixture.mock.workflows.get(fixture.after.workflowId)!
  fixture.mock.workflows.set(current.id, { ...current, nodes: current.nodes.map(node =>
    node.id === fixture.first.id ? { ...node, name: 'Renamed current node' } : node) })
  measureBoardWire(fixture.mock)
  await mountMeasuredBoard(`${boardHref(fixture.runs.before.scope)}&boardPanel=agent&boardNodeId=${fixture.first.id}&boardAgentTab=settings`)
  const rail = await screen.findByRole('complementary', { name: 'Workflow side panel' })
  expect(await within(rail).findByRole('heading', { level: 2, name: fixture.first.name! })).toBeVisible()
}, 15_000)

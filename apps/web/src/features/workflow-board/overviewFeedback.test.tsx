import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it } from 'vitest'
import { HttpResponse } from 'msw'
import { nextDraftKey } from '../board-core'
import { useGraphDraftStore } from '../graph'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard, type InspectionFixture } from './eng05D.testSupport'

installBoardTestLifecycle()
let fixture: InspectionFixture, serial = 0
beforeEach(async () => {
  fixture = await inspectionBoardFixture(`overview-feedback-${++serial}`)
  fixture.mock.controls.start = true
})
const href = () => `/workspaces/${fixture.mock.workspaceId}?workflowId=${fixture.after.workflowId}&boardView=overview`

it('shows a rejected Overview Start and reloads the saved draft without leaving Overview', async () => {
  fixture.mock.controls.unsupportedStart = true
  measureBoardWire(fixture.mock)
  const { router } = await mountMeasuredBoard(href()), user = userEvent.setup()
  const start = await screen.findByRole('button', { name: 'Start saved version' })
  await waitFor(() => expect(start).toBeEnabled())
  await user.click(start)
  expect(await screen.findByText('This saved version can no longer start. Reload the saved draft before starting another Run.')).toBeVisible()
  expect(start).toBeDisabled()
  const reload = screen.getByRole('button', { name: 'Reload saved draft', hidden: true })
  expect(reload).toBeVisible()
  await user.click(reload)
  expect(await screen.findByText('The saved draft still points to the rejected version. Reload after a newer version is available.')).toBeVisible()
  expect(start).toBeDisabled()
  fixture.mock.controls.unsupportedStart = false
  fixture.mock.install({ ...fixture.after.definition, name: 'Reloaded saved workflow' }, true)
  await user.click(screen.getByRole('button', { name: 'Reload saved draft' }))
  expect(await screen.findByRole('heading', { name: 'Reloaded saved workflow' })).toBeVisible()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Start saved version' })).toBeEnabled())
  expect(router.state.location.search.boardView).toBe('overview')
  expect(screen.getAllByTestId('unified-workflow-board')).toHaveLength(1)
}, 15_000)

it('shows Overview Save validation, alerts and field recovery while retaining unsaved edits', async () => {
  measureBoardWire(fixture.mock, request => request.method === 'POST' && new URL(request.url).pathname.endsWith('/definition/edits')
    ? HttpResponse.json({ error: { code: 'GRAPH_INVALID', message: 'Fix the workflow settings below.', details: { issues: [
      { code: 'EXECUTION_LIMIT_TOO_LOW', path: ['executionPolicy', 'maxNodeExecutions'], message: 'Increase the execution limit.', minimum: 3, actual: 1 },
    ] } } }, { status: 409 }) : undefined)
  await mountMeasuredBoard(href())
  const key = nextDraftKey(fixture.mock.workspaceId, fixture.after.workflowId), user = userEvent.setup()
  await waitFor(() => expect(useGraphDraftStore.getState().nextDrafts[key]).toBeDefined())
  act(() => useGraphDraftStore.getState().changeNextDraft(key, graph => ({ ...graph, name: 'Unsaved Overview edit' })))
  await user.click(screen.getByRole('button', { name: 'Save workflow' }))
  expect(await screen.findByText('Can’t save — fix 1 setting')).toBeVisible()
  const fix = screen.getByRole('button', { name: 'Fix setting', hidden: true })
  expect(fix).toBeVisible()
  await user.click(fix)
  expect(await screen.findByRole('complementary', { name: 'Workflow settings' })).toBeVisible()
  expect(screen.getByLabelText('Agent turns per run')).toHaveFocus()
  const alerts = screen.getByRole('button', { name: /Workflow alerts,/ })
  expect(alerts).toBeVisible()
  await user.click(alerts)
  const dialog = await screen.findByRole('dialog', { name: 'Workflow alerts' })
  expect(within(dialog).getByText('Increase the execution limit.', { exact: false })).toBeVisible()
  const issue = within(dialog).getByText('Increase the execution limit.', { exact: false }).closest('li')!
  await user.click(within(issue).getByRole('button', { name: 'Review setting' }))
  expect(screen.getByLabelText('Agent turns per run')).toHaveFocus()
  expect(useGraphDraftStore.getState().nextDrafts[key]!.graph.name).toBe('Unsaved Overview edit')
}, 15_000)

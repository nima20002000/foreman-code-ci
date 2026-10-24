import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { readRunInspectionKey, RunExecutionDetailSchema } from '@foreman-code/contracts/current'
import { server } from '../../mocks/server'
import { fixture as authoringFixture } from '../graph/nextDraft/core.cases'
import { useRunsSelectorUi } from '../runs-selector'
import { installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard } from './eng05D.testSupport'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { meaningfulSaveFixture } from './meaningfulSave.testSupport'

installBoardTestLifecycle()
afterEach(() => useRunsSelectorUi.getState().setOpen(null))

it('filters Runs without prompting or losing an unapplied Master hierarchy form', async () => {
  const fixture = await meaningfulSaveFixture(false, authoringFixture(['orchestrator', 'orchestrator', 'coder']))
  measureBoardWire(fixture.mock, fixture.reply)
  const { router } = await mountMeasuredBoard(fixture.href), user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Workflow settings' }))
  const hierarchy = await screen.findByRole('region', { name: 'Master hierarchy' })
  await user.selectOptions(within(hierarchy).getByLabelText('Master'), 'node-0')
  await user.selectOptions(within(hierarchy).getByLabelText('Node 2 reports to'), 'node-1')
  await user.click(screen.getByRole('button', { name: 'Runs' }))
  const filter = await screen.findByRole('combobox', { name: 'Run status' })
  await user.selectOptions(filter, 'failed')
  await waitFor(() => expect(router.state.location.search.runStatus).toBe('failed'))
  expect(screen.queryByRole('alertdialog', { name: 'Save changes before leaving?' })).not.toBeInTheDocument()
  expect(filter).toHaveValue('failed')
  expect(await screen.findByText('No runs match this status in loaded history.')).toBeVisible()
  expect(screen.getByRole('region', { name: 'Master hierarchy' })).toBe(hierarchy)
  expect(within(hierarchy).getByLabelText('Master')).toHaveValue('node-0')
  expect(within(hierarchy).getByLabelText('Node 2 reports to')).toHaveValue('node-1')
  expect(within(hierarchy).getByRole('button', { name: 'Apply hierarchy' })).toBeEnabled()
}, 15_000)

it.each(['current', 'historical'] as const)('inspects the exact failed activity from the %s Board', async selection => {
  const fixture = await inspectionBoardFixture(`activity-inspection-${selection}`)
  const owner = fixture.runs.after, attempt = await fixture.execution(owner, 0)
  const detail = RunExecutionDetailSchema.parse({ ...attempt.detail,
    execution: { ...attempt.detail.execution, acceptedResultAvailable: false }, acceptedResult: { status: 'not_accepted' },
    reportedResult: { outcome: 'failed', error: { code: 'ATTEMPT_FAILED', message: 'Agent attempt failed', retryable: true } } })
  fixture.mock.inspection.set(owner.run.id, [{ ...attempt, detail }])
  measureBoardWire(fixture.mock)
  server.use(
    http.get(`*/api/management/workspaces/${owner.scope.workspaceId}/workflows/${owner.scope.workflowId}/runs/summaries`, () =>
      HttpResponse.json({ items: [{ runId: owner.run.id, shortId: owner.run.id.slice(-8),
        startedAt: owner.run.startedAt, status: 'succeeded', trigger: 'manual' }], pageInfo: { nextCursor: null } })),
    http.get(`*/api/management/workspaces/${owner.scope.workspaceId}/runs/${owner.run.id}/activities`, () =>
      HttpResponse.json({ scope: owner.scope, mode: 'initial', highWater: '1', retainedFrom: '1',
        nextCursor: 'failed-attempt', olderCursor: null, hasMore: false, items: [{ id: 'failed-activity', scope: owner.scope,
          sequence: '1', occurredAt: owner.run.createdAt, source: 'backend', kind: 'agent_work', status: 'failed', severity: 'error',
          summary: 'Agent attempt failed', refs: { executionId: detail.execution.executionId },
          actor: { agentId: fixture.first.agentId, agentName: 'Worker', nodeId: fixture.first.id, nodeName: 'Worker' } }] })),
  )
  const href = `/workspaces/${owner.scope.workspaceId}?workflowId=${owner.scope.workflowId}`
    + `&boardPanel=agent&boardNodeId=${fixture.first.id}&boardAgentTab=details`
    + (selection === 'historical' ? `&selectedRunId=${owner.run.id}` : '')
  const { router } = await mountMeasuredBoard(href)
  if (selection === 'current') {
    const panel = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    await userEvent.click(await within(panel).findByRole('tab', { name: 'Activity' }))
  } else await userEvent.click(await screen.findByRole('button', { name: 'Activities' }))
  const row = (await screen.findByText('Agent attempt failed')).closest('li')!
  expect(router.state.location.search.selectedRunId).toBe(selection === 'historical' ? owner.run.id : undefined)
  await userEvent.click(within(row).getByRole('button', { name: 'Inspect failure' }))
  const popover = await screen.findByRole('region', { name: 'Activities popover' })
  const execution = await within(popover).findByRole('article', { name: `Execution ${detail.execution.executionId}` })
  expect(execution).toBeVisible()
  expect(within(execution).getByText('No accepted result is recorded for this exact execution.')).toBeVisible()
  expect(router.state.location.search).toMatchObject({ runId: owner.run.id,
    workflowVersionId: owner.scope.workflowVersionId, executionSemanticsVersion: 3, runNodeId: fixture.first.id })
  expect(readRunInspectionKey(router.state.location.search.runExchangeKey)).toEqual({ executionId: detail.execution.executionId })
}, 15_000)

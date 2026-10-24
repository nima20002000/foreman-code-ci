import { fireEvent, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it, vi } from 'vitest'
import { http, HttpResponse } from 'msw'
import { RunActivityPublicSchema } from '@foreman-code/contracts/current'
import { RunDropdownPageSchema } from '@foreman-code/contracts/run-snapshots'
import { server } from '../../mocks/server'
import { useRunsSelectorUi } from '../runs-selector'
import { installBoardTestLifecycle, mountMeasuredBoard } from './eng05D.testSupport'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'
import { ciResultJob, ciResultTests } from './inspect/ciResults.testSupport'

installBoardTestLifecycle()
afterEach(() => useRunsSelectorUi.getState().setOpen(null))

async function fixtureForCi(suffix: string) {
  vi.stubGlobal('EventSource', undefined)
  const fixture = await inspectionBoardFixture(suffix)
  const scope = fixture.runs.before.scope
  const activity = RunActivityPublicSchema.parse({ id: 'ci-failed', scope, sequence: '1',
    occurredAt: '2026-10-01T12:00:00.000Z', source: 'backend', kind: 'agent_work', status: 'failed', severity: 'error',
    summary: 'CI failed', refs: { ciTicketId: ciResultJob.ticketId }, ci: ciResultJob.ci })
  server.use(...fixture.mock.handlers)
  server.use(
    http.get(`*/api/management/workspaces/${scope.workspaceId}/runs/${scope.runId}/activities`, () => HttpResponse.json({
      scope, items: [activity], mode: 'initial', highWater: '1', retainedFrom: '1',
      nextCursor: 'ci-activity-1', olderCursor: null, hasMore: false })),
    http.get(`*/api/management/workspaces/${scope.workspaceId}/ci`, ({ request }) => {
      const runId = new URL(request.url).searchParams.get('runId')
      return HttpResponse.json({ runId, jobs: runId === scope.runId ? [ciResultJob] : [], truncated: false })
    }),
    http.get(`*/api/management/workspaces/${scope.workspaceId}/ci/${ciResultJob.ticketId}/tests`,
      () => HttpResponse.json({ ticketId: ciResultJob.ticketId, tests: ciResultTests })))
  server.use(http.get(`*/api/management/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/runs/summaries`,
    () => HttpResponse.json(RunDropdownPageSchema.parse({ items: [...fixture.mock.runs.values()].map(({ run }) => ({
      runId: run.id, shortId: run.id.slice(-8),
      startedAt: run.startedAt ?? null, status: 'succeeded', trigger: 'manual',
    })), pageInfo: { nextCursor: null } }))))
  return fixture
}

it('opens the exact Activity CI results from a selected Run Overview in the mounted Board', async () => {
  const fixture = await fixtureForCi('ci-overview'), scope = fixture.runs.before.scope
  const { router } = await mountMeasuredBoard(`/workspaces/${scope.workspaceId}?workflowId=${scope.workflowId}&selectedRunId=${scope.runId}&boardView=overview`)
  expect(await screen.findByRole('region', { name: 'Workflow Overview' })).toBeVisible()
  await userEvent.click(await screen.findByRole('button', { name: 'Activities' }))
  await userEvent.click(await screen.findByRole('button', { name: 'Open CI results' }))
  const ci = await screen.findByRole('complementary', { name: 'CI server' })
  expect(await within(ci).findByText('failing example')).toBeVisible()
  expect(router.state.location.search.boardCiTicketId).toBe(ciResultJob.ticketId)
  expect(router.state.location.search.selectedRunId).toBe(scope.runId)
}, 15_000)

it('clears the prior Run CI ticket when another Run is chosen through the Board Runs selector', async () => {
  const fixture = await fixtureForCi('ci-run-change'), scope = fixture.runs.before.scope
  const nextRun = fixture.runs.after.run
  // Give the next Run a distinct displayed date in the normal Runs menu.
  fixture.mock.runs.set(nextRun.id, { ...fixture.mock.runs.get(nextRun.id)!, run: { ...nextRun, startedAt: '2026-10-02T00:00:00.000Z' } })
  const { router } = await mountMeasuredBoard(`/workspaces/${scope.workspaceId}?workflowId=${scope.workflowId}&selectedRunId=${scope.runId}&boardCiTicketId=${ciResultJob.ticketId}`)
  const ci = await screen.findByRole('complementary', { name: 'CI server' })
  expect(await within(ci).findByText('failing example')).toBeVisible()
  await userEvent.click(screen.getByRole('button', { name: 'Runs' }))
  const menu = await screen.findByRole('menu', { name: 'Runs' })
  await userEvent.click(await within(menu).findByRole('menuitemradio', { name: /Oct 2, 2026/ }))
  await waitFor(() => expect(screen.getByRole('region', { name: 'Selected Run board' })).toHaveAttribute('data-run-id', nextRun.id))
  await waitFor(() => expect(router.state.location.search.boardCiTicketId).toBeUndefined())
  expect(screen.queryByRole('complementary', { name: 'CI server' })).not.toBeInTheDocument()
  fireEvent.click(await screen.findByRole('button', { name: /^CI server, .*Open CI jobs/ }))
  const nextCi = await screen.findByRole('complementary', { name: 'CI server' })
  expect(await within(nextCi).findByText('No CI jobs in this Run yet')).toBeVisible()
  expect(within(nextCi).getByRole('tab', { name: /Jobs/ })).toHaveAttribute('aria-selected', 'true')
}, 15_000)

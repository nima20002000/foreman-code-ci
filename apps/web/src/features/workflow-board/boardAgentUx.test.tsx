import { act, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { RepeatGraphCurrentStateSchema } from '@foreman-code/contracts/current'
import { server } from '../../mocks/server'
import { deferred } from '../../test/deferred'
import canvasStyles from '../../shared/ui/nocturne/canvas.css?inline'
import boardStyles from './workflowBoard.css?inline'
import { installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard, setRunState, type InspectionFixture } from './eng05D.testSupport'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'

installBoardTestLifecycle()
let fixture: InspectionFixture
beforeEach(async () => {
  fixture = await inspectionBoardFixture('agent-ux')
  server.use(...fixture.mock.handlers,
    http.get('*/api/browser/profiles', () => HttpResponse.json({ profiles: [], replicas: [], presentReplicas: [], pendingReplicas: [], nextCursor: null, revision: 0 })))
})
const href = () => `/workspaces/${fixture.mock.workspaceId}?workflowId=${fixture.after.workflowId}`

it('gives Completed enough status width on a default Worker circle', async () => {
  setRunState(fixture, fixture.runs.after.scope, 'running')
  const current = fixture.mock.currents.get(fixture.runs.after.run.id)!
  fixture.mock.currents.set(current.scope.runId, RepeatGraphCurrentStateSchema.parse({ ...current,
    state: { ...current.state, executions: [{
      identity: { workflowNodeId: fixture.first.id, executionId: 'completed-worker', agentId: fixture.first.agentId,
        agentConfigurationVersionId: fixture.after.agentConfigurationVersionIds[fixture.first.agentId], attempt: 1, occurrence: null },
      inputDigest: `sha256:${'1'.repeat(64)}`, previousExecutionId: null, state: 'completed', resultOutcome: 'succeeded',
    }] } }))
  const { container } = await mountMeasuredBoard(href())
  const style = document.createElement('style')
  style.textContent = canvasStyles
  container.append(style)
  const node = await screen.findByRole('button', { name: new RegExp(`${fixture.first.name}.*Completed`) })
  const label = within(node).getByText('Completed')
  expect(label).toBeVisible()
  // At 11px with eyebrow tracking, the dot and COMPLETED need a 96px budget.
  // jsdom cannot measure text, but does apply the real node's max-width rule.
  const inset = Number(getComputedStyle(label).maxWidth.match(/^calc\(100% - (\d+)px\)$/)?.[1])
  expect(Number.isFinite(inset)).toBe(true)
  expect(120 - inset).toBeGreaterThanOrEqual(96)
}, 15_000)

it('separates the running indicator from its word in the Board toolbar', async () => {
  setRunState(fixture, fixture.runs.after.scope, 'running')
  const { container } = await mountMeasuredBoard(href())
  const style = document.createElement('style')
  style.textContent = boardStyles
  container.append(style)
  const toolbar = await screen.findByRole('group', { name: 'Board controls' })
  const status = within(toolbar).getByRole('status')
  expect(status).toHaveTextContent('Running')
  const layout = getComputedStyle(status)
  expect(layout.display).toBe('inline-flex')
  expect(parseFloat(layout.gap)).toBeGreaterThanOrEqual(6)
  expect(status.querySelector('[aria-hidden="true"]')).toBeInTheDocument()
}, 15_000)

it('confirms a successful Run in plain words', async () => {
  fixture.mock.controls.start = true
  await mountMeasuredBoard(href())
  const start = await screen.findByRole('button', { name: 'Start saved version' })
  await waitFor(() => expect(start).toBeEnabled())
  await userEvent.click(start)
  expect(await screen.findByText('Run started.')).toBeVisible()
  expect(fixture.mock.calls.filter(call => call.method === 'POST' && call.path.endsWith('/runs'))).toHaveLength(1)
}, 15_000)

it('shows a slow Start as progress and removes confirmation once the Run is known', async () => {
  fixture.mock.controls.start = true
  const reply = deferred<void>(), received = deferred<void>()
  measureBoardWire(fixture.mock, async request => {
    if (request.method === 'POST' && new URL(request.url).pathname.endsWith('/runs')) {
      received.resolve()
      await reply.promise
    }
    return undefined
  })
  await mountMeasuredBoard(href())
  const start = await screen.findByRole('button', { name: 'Start saved version' })
  await waitFor(() => expect(start).toBeEnabled())
  await userEvent.click(start)
  await received.promise
  try {
    await act(async () => { await new Promise(resolve => setTimeout(resolve, 5000)) })
    expect(screen.queryByText('An earlier start may have gone through.')).not.toBeInTheDocument()
    expect(screen.queryByRole('button', { name: 'Reconcile Start' })).not.toBeInTheDocument()
    expect(start).toBeDisabled()
    expect(start).toHaveTextContent('Starting…')
  } finally { await act(async () => { reply.resolve() }) }
  expect(await screen.findByText('Run started.')).toBeVisible()
  await waitFor(() => expect(screen.getByRole('button', { name: 'Stop' })).toBeEnabled())
  expect(screen.queryByRole('button', { name: 'Reconcile Start', hidden: true })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Recover Start', hidden: true })).not.toBeInTheDocument()
}, 15_000)

it('labels the Board status Stopping while an accepted Stop is cleaning up', async () => {
  setRunState(fixture, fixture.runs.after.scope, 'running', true)
  const current = fixture.mock.currents.get(fixture.runs.after.run.id)!
  fixture.mock.currents.set(fixture.runs.after.run.id, RepeatGraphCurrentStateSchema.parse({ ...current,
    state: { ...current.state, run: { ...current.state.run, stopRequested: true } } }))
  await mountMeasuredBoard(href())
  expect(await screen.findByText('Cleaning up…')).toBeVisible()
  const status = within(screen.getByRole('group', { name: 'Board controls' })).getByRole('status')
  expect(status).toHaveTextContent(/^Stopping$/)
  expect(status).not.toHaveTextContent('Running')
}, 15_000)

it('labels an earlier-version Run Stopping while retaining the current draft', async () => {
  const { scope, run } = fixture.runs.before
  setRunState(fixture, scope, 'running', true)
  const current = fixture.mock.currents.get(run.id)!
  fixture.mock.currents.set(run.id, RepeatGraphCurrentStateSchema.parse({ ...current,
    state: { ...current.state, run: { ...current.state.run, stopRequested: true } } }))
  await mountMeasuredBoard(href())
  expect(await screen.findByText('Cleaning up…')).toBeVisible()
  const controls = within(screen.getByRole('group', { name: 'Board controls' }))
  expect(await controls.findByRole('button', { name: 'Stopping' })).toHaveAttribute('title',
    'A Run of an earlier saved version is running. Show it.')
  expect(controls.queryByRole('button', { name: 'Running' })).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: /^Added later,/ })).toBeVisible()
  expect(screen.queryByRole('region', { name: 'Selected Run board' })).not.toBeInTheDocument()
}, 15_000)

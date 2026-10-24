import { QueryClient, QueryClientProvider, useQuery } from '@tanstack/react-query'
import { act, fireEvent, render, screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import { server } from '../../../mocks/server'
import { CiServerDialog } from './CiServer'
import { runCiApi } from './ciServer'
import { ciResultJob, ciResultTests } from './ciResults.testSupport'

const scope = { workspaceId: 'workspace-a', workflowId: 'workflow-a', runId: 'run-a',
  workflowVersionId: 'version-a', executionSemanticsVersion: 3 as const }
const clients: QueryClient[] = []
afterEach(() => { clients.splice(0).forEach(client => client.clear()); vi.useRealTimers() })

function Readback() {
  const query = useQuery({ queryKey: ['ci-readback'],
    queryFn: ({ signal }) => runCiApi.list(scope, { signal }), refetchInterval: 1500 })
  return <CiServerDialog open onOpenChange={() => {}} scope={scope} jobs={query.data?.jobs ?? []}
    names={new Map()} truncated={false} error={query.isError} loading={query.isPending} readError={query.error} onRefresh={() => void query.refetch()} />
}
function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}><Readback /></QueryClientProvider>)
}

it('reads test files collected after the terminal job summary changes', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let collected = false
  server.use(
    http.get('*/api/management/workspaces/:workspaceId/ci', () => HttpResponse.json({ runId: scope.runId,
      jobs: [{ ...ciResultJob, tests: collected ? ciResultTests.summary : null }], truncated: false })),
    http.get('*/api/management/workspaces/:workspaceId/ci/:ticketId/tests', () => HttpResponse.json({
      ticketId: ciResultJob.ticketId, tests: collected ? ciResultTests : null })),
  )
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /Show tests of/ }))
  await screen.findByText('No test results for this job')
  collected = true
  await act(async () => { await vi.advanceTimersByTimeAsync(1500) })
  expect(await screen.findByText('failing example')).toBeVisible()
})

it.each([
  ['running', 'CI_EXECUTOR_UNAVAILABLE: Worker disconnected; execution ownership retained.'],
  ['queued', 'No compatible build computer is available.'],
] as const)('shows the API diagnostic for a %s job in the table and detail header', async (state, message) => {
  server.use(
    http.get('*/api/management/workspaces/:workspaceId/ci', () => HttpResponse.json({ runId: scope.runId,
      jobs: [{ ...ciResultJob, message, ci: { ...ciResultJob.ci, state } }], truncated: false })),
    http.get('*/api/management/workspaces/:workspaceId/ci/:ticketId/tests', () => HttpResponse.json({
      ticketId: ciResultJob.ticketId, tests: null })),
  )
  mount()
  await screen.findByRole('button', { name: /Show tests of/ })
  expect(screen.getByText(message)).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: /Show tests of/ }))
  expect(await screen.findByText(message)).toBeVisible()
})


it.each(['running', 'queued'] as const)('cancels only the selected %s CI ticket and shows its confirmed outcome', async state => {
  const requests: unknown[] = []
  let canceled = false
  server.use(
    http.get('*/api/management/workspaces/:workspaceId/ci', () => HttpResponse.json({ runId: scope.runId,
      jobs: [{ ...ciResultJob, ci: { ...ciResultJob.ci, state: canceled ? 'canceled' : state } }], truncated: false })),
    http.get('*/api/management/workspaces/:workspaceId/ci/:ticketId/tests', () => HttpResponse.json({ ticketId: ciResultJob.ticketId, tests: null })),
    http.delete('*/api/management/workspaces/:workspaceId/ci/:ticketId', ({ params }) => {
      requests.push({ workspaceId: params.workspaceId, ticketId: params.ticketId }); canceled = true
      return HttpResponse.json({ run: { ...ciResultJob.ci, state: 'canceled', workspaceId: scope.workspaceId, commit: 'a'.repeat(40), repository: 'owner/repo', message: null, initiator: { principalId: 'human', executionId: null } } })
    }),
  )
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /Show tests of/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel CI job' }))
  expect(await screen.findByText('Cancellation confirmed.')).toBeVisible()
  expect(requests).toEqual([{ workspaceId: scope.workspaceId, ticketId: ciResultJob.ticketId }])
})

it('follows pending cancellation through ticket readback until executor cleanup is confirmed', async () => {
  vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] })
  let cleanupPending = true
  let ticketReads = 0
  const run = () => ({ ...ciResultJob.ci, state: 'canceled', executorCleanupPending: cleanupPending,
    workspaceId: scope.workspaceId, commit: 'a'.repeat(40), repository: 'owner/repo', message: null,
    initiator: { principalId: 'human', executionId: null } })
  server.use(
    http.get('*/api/management/workspaces/:workspaceId/ci', () => HttpResponse.json({ runId: scope.runId,
      jobs: [{ ...ciResultJob, ci: { ...ciResultJob.ci, state: ticketReads ? 'canceled' : 'running' } }], truncated: false })),
    http.get('*/api/management/workspaces/:workspaceId/ci/:ticketId/tests', () => HttpResponse.json({ ticketId: ciResultJob.ticketId, tests: null })),
    http.delete('*/api/management/workspaces/:workspaceId/ci/:ticketId', () => HttpResponse.json({ run: run() })),
    http.get('*/api/management/workspaces/:workspaceId/ci/:ticketId', () => {
      ticketReads += 1
      return HttpResponse.json({ run: run() })
    }),
  )
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /Show tests of/ }))
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel CI job' }))
  expect(await screen.findByText('Cancellation requested. Waiting for the executor to stop.')).toBeVisible()
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(screen.getByText('Cancellation requested. Waiting for the executor to stop.')).toBeVisible()
  cleanupPending = false
  await act(async () => { await vi.advanceTimersByTimeAsync(3000) })
  expect(await screen.findByText('Cancellation confirmed.')).toBeVisible()
  expect(screen.queryByText('Cancellation requested. Waiting for the executor to stop.')).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Cancel CI job' })).not.toBeInTheDocument()
})

it.each(['canceled', 'running'] as const)('reconciles cancellation returned as %s with later confirmed ticket state', async returnedState => {
  let canceled = false
  const canceledTickets: string[] = []
  server.use(
    http.get('*/api/management/workspaces/:workspaceId/ci', () => HttpResponse.json({ runId: scope.runId,
      jobs: [{ ...ciResultJob, ci: { ...ciResultJob.ci, state: canceled ? 'canceled' : 'running' } }], truncated: false })),
    http.delete('*/api/management/workspaces/:workspaceId/ci/:ticketId', ({ params }) => {
      canceledTickets.push(String(params.ticketId)); canceled = true
      return HttpResponse.json({ run: { ...ciResultJob.ci, workspaceId: scope.workspaceId,
        repository: 'owner/repo', commit: 'a'.repeat(40), scope: 'affected', files: [], state: returnedState,
        dispatchAttempts: 0, noSupersede: false, message: null,
        initiator: { principalId: 'operator', executionId: null }, queuedAt: ciResultJob.ci.queuedAt } })
    }),
    http.get('*/api/management/workspaces/:workspaceId/ci/:ticketId', () => HttpResponse.json({ run: {
      ...ciResultJob.ci, workspaceId: scope.workspaceId, repository: 'owner/repo', commit: 'a'.repeat(40),
      state: 'canceled', message: null, initiator: { principalId: 'operator', executionId: null },
    } })),
  )
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel CI job' }))
  expect(await screen.findByText('Canceled')).toBeVisible()
  expect(canceledTickets).toEqual([ciResultJob.ticketId])
  expect(screen.queryByRole('button', { name: 'Cancel CI job' })).not.toBeInTheDocument()
})


it('retries an unavailable completed-job log through the visible selected ticket control', async () => {
  let reads = 0
  server.use(
    http.get('*/api/management/workspaces/:workspaceId/ci', () => HttpResponse.json({ runId: scope.runId, jobs: [ciResultJob], truncated: false })),
    http.get('*/api/management/workspaces/:workspaceId/ci/:ticketId/tests', () => HttpResponse.json({ ticketId: ciResultJob.ticketId, tests: null })),
    http.get('*/api/management/workspaces/:workspaceId/ci/:ticketId/logs', () => ++reads === 1
      ? HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Offline' } }, { status: 503 })
      : HttpResponse.json({ text: 'Recovered job log', nextOffset: 17, logBytes: 17, maxBytes: 32768 })),
  )
  mount()
  fireEvent.click(await screen.findByRole('button', { name: /Show tests of/ }))
  fireEvent.click(screen.getByRole('tab', { name: 'Log' }))
  await screen.findByText('The log is unavailable right now.')
  fireEvent.click(screen.getByRole('button', { name: 'Retry log' }))
  expect(await screen.findByText('Recovered job log')).toHaveTextContent('Recovered job log')
  expect(reads).toBe(2)
})

it('retries a failed settled jobs read from the CI window without blaming access', async () => {
  let failed = true
  server.use(http.get('*/api/management/workspaces/:workspaceId/ci', () => failed
    ? HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Connection interrupted.' } }, { status: 503 })
    : HttpResponse.json({ runId: scope.runId, jobs: [ciResultJob], truncated: false })))
  mount()
  await screen.findByText('CI jobs could not be read.')
  expect(screen.queryByText(/needs the CI read grants/)).not.toBeInTheDocument()
  failed = false
  fireEvent.click(screen.getByRole('button', { name: 'Retry CI jobs' }))
  expect(await screen.findByRole('button', { name: /Show tests of/ })).toBeVisible()
})

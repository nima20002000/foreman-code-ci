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

it('cancels an active ticket and shows its confirmed resulting state', async () => {
  let canceled = false
  const canceledTickets: string[] = []
  server.use(
    http.get('*/api/management/workspaces/:workspaceId/ci', () => HttpResponse.json({ runId: scope.runId,
      jobs: [{ ...ciResultJob, ci: { ...ciResultJob.ci, state: canceled ? 'canceled' : 'running' } }], truncated: false })),
    http.delete('*/api/management/workspaces/:workspaceId/ci/:ticketId', ({ params }) => {
      canceledTickets.push(String(params.ticketId)); canceled = true
      return HttpResponse.json({ run: { ...ciResultJob.ci, workspaceId: scope.workspaceId,
        repository: 'owner/repo', commit: 'a'.repeat(40), scope: 'affected', files: [], state: 'canceled',
        dispatchAttempts: 0, noSupersede: false, message: null,
        initiator: { principalId: 'operator', executionId: null }, queuedAt: ciResultJob.ci.queuedAt } })
    }),
  )
  mount()
  fireEvent.click(await screen.findByRole('button', { name: 'Cancel CI job' }))
  expect(await screen.findByText('Canceled')).toBeVisible()
  expect(canceledTickets).toEqual([ciResultJob.ticketId])
  expect(screen.queryByRole('button', { name: 'Cancel CI job' })).not.toBeInTheDocument()
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

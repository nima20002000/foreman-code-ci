import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { it, expect, vi } from 'vitest'
import { server } from '../../mocks/server'
import { JobNodePanel, JobNodePicker } from './JobNodePanel'
import { definition } from './fixtures'
it('does not substitute another revision when the exact saved version disagrees with the node pin', async () => {
  server.use(http.get('*/api/management/workspaces/:workspaceId/jobs/definitions/:id/versions/:versionId', () => HttpResponse.json({ definition: { ...definition, revision: 2 } })))
  render(<QueryClientProvider client={new QueryClient()}><JobNodePanel workspaceId={definition.workspaceId} definitionId={definition.id} definitionRevision={1} definitionVersionId={definition.versionId} /></QueryClientProvider>)
  expect(await screen.findByText(/No substitute command is shown/)).toBeInTheDocument()
  expect(screen.queryByText('Exact command')).toBeNull()
})
it('keeps a long saved job name readable and selects its exact saved definition', async () => {
  const longDefinition = { ...definition, name: '長い名前'.repeat(50) }
  const chosen = vi.fn()
  server.use(
    http.get('*/api/management/workspaces/:workspaceId/jobs/definitions/:id/versions/:versionId', () => HttpResponse.json({ definition: longDefinition })),
    http.get('*/api/management/workspaces/:workspaceId/jobs/definitions', () => HttpResponse.json({ definitions: [longDefinition] })),
  )
  render(<QueryClientProvider client={new QueryClient()}><JobNodePanel workspaceId={definition.workspaceId} definitionId={definition.id} definitionRevision={definition.revision} definitionVersionId={definition.versionId} /><JobNodePicker workspaceId={definition.workspaceId} onChoose={chosen} /></QueryClientProvider>)
  expect(await screen.findByRole('heading', { name: longDefinition.name })).toBeInTheDocument()
  await userEvent.click(await screen.findByRole('button', { name: `${longDefinition.name} · revision 1` }))
  expect(chosen).toHaveBeenCalledWith(longDefinition)
})

it('retries denied saved job reads without replacing the pinned selection', async () => {
  server.use(
    http.get('*/api/management/workspaces/:workspaceId/jobs/definitions/:id/versions/:versionId', () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Denied.' } }, { status: 403 })),
    http.get('*/api/management/workspaces/:workspaceId/jobs/definitions', () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Denied.' } }, { status: 403 })),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><JobNodePanel workspaceId={definition.workspaceId} definitionId={definition.id} definitionRevision={definition.revision} definitionVersionId={definition.versionId} /><JobNodePicker workspaceId={definition.workspaceId} onChoose={vi.fn()} /></QueryClientProvider>)
  try {
    await screen.findByText('Job unavailable')
    await screen.findByText('Jobs unavailable')
    expect(screen.queryByRole('heading', { name: definition.name })).not.toBeInTheDocument()
    server.use(
      http.get('*/api/management/workspaces/:workspaceId/jobs/definitions/:id/versions/:versionId', () => HttpResponse.json({ definition })),
      http.get('*/api/management/workspaces/:workspaceId/jobs/definitions', () => HttpResponse.json({ definitions: [definition] })),
    )
    await userEvent.click(screen.getByRole('button', { name: 'Retry saved job' }))
    expect(await screen.findByRole('heading', { name: definition.name })).toBeVisible()
    await userEvent.click(within(screen.getByRole('region', { name: 'Choose a saved job for this node' })).getByRole('button', { name: 'Retry jobs' }))
    expect(await screen.findByRole('button', { name: `${definition.name} · revision 1` })).toBeVisible()
  } finally { view.unmount(); client.clear() }
})

import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkspaceShell } from './WorkspaceShell'

it('offers an in-place retry when the initial workspace catalog fails', async () => {
  let fail = true
  server.use(http.get('/api/management/workspaces', () => fail
    ? HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Catalog offline.' } }, { status: 503 })
    : HttpResponse.json({ items: [{ workspace: { id: 'workspace-other', name: 'Other project' }, revision: 1,
      archivedAt: null, executionLocation: null, locationRevision: 0, locationValidation: { status: 'unconfigured' } }], pageInfo: { nextCursor: null } })))
  renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
  const navigation = within(await screen.findByRole('complementary', { name: 'Primary navigation' }))
  expect(await navigation.findByText('Workspaces unavailable')).toBeVisible()
  // A separately loaded current workspace must stay available while the catalog recovers.
  expect(await navigation.findByRole('button', { name: 'Website' })).toBeVisible()
  fail = false
  await userEvent.setup().click(navigation.getByRole('button', { name: 'Retry workspaces' }))
  expect(await navigation.findByRole('button', { name: 'Other project' })).toBeVisible()
  await waitFor(() => expect(navigation.queryByText('Workspaces unavailable')).not.toBeInTheDocument())
})

it('offers an in-place retry when the initial workflow catalog fails', async () => {
  let fail = true
  server.use(http.get('/api/management/workspaces/workspace-1/workflows', () => {
    if (fail) return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Catalog offline.' } }, { status: 503 })
    return undefined
  }))
  renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
  const workflows = within(await screen.findByRole('region', { name: 'Workspace workflows' }))
  expect(await workflows.findByText('Workflows unavailable')).toBeVisible()
  fail = false
  await userEvent.setup().click(workflows.getByRole('button', { name: 'Retry workflows' }))
  expect(await workflows.findByRole('button', { name: 'Research to review' })).toBeVisible()
  await waitFor(() => expect(workflows.queryByText('Workflows unavailable')).not.toBeInTheDocument())
})

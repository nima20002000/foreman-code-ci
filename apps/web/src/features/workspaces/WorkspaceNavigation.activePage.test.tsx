import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { WorkspaceNavigation } from './WorkspaceNavigation'

it('keeps every loaded workspace in the sidebar when the active workspace is beyond the loaded pages', async () => {
  server.use(http.get('*/api/management/workspaces/workspace-far', () => HttpResponse.json({
    workspace: { id: 'workspace-far', name: 'Far workspace' }, revision: 0, archivedAt: null,
    executionLocation: null, locationRevision: 0, locationValidation: { status: 'unconfigured' } })))
  const pagination = { hasNextPage: true, isFetchingNextPage: false, isFetchNextPageError: false,
    fetchNextPage: vi.fn(async () => ({ hasNextPage: true, isError: false })) }
  renderWithRouter(<WorkspaceNavigation workspaceId="workspace-far" workflowsContent={<span />} workspacePagination={pagination}
    workspaces={[{ id: 'workspace-1', name: 'First loaded' }, { id: 'workspace-2', name: 'Second loaded' }]} />)
  expect(await screen.findByText('Far workspace')).toBeVisible()
  expect(screen.getByText('First loaded')).toBeVisible()
  expect(screen.getByText('Second loaded')).toBeVisible()
})

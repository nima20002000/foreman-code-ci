import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { renderWithRouter } from '../../test/renderWithRouter'
import { RemoveWorkspaceButton } from './RemoveWorkspaceButton'

it('retries removal against the workspace revision the conflict revealed instead of the stale one', async () => {
  const workspace = (revision: number) => ({ workspace: { id: 'workspace-1', name: 'Website' }, revision, archivedAt: null,
    executionLocation: null, locationRevision: 0, locationValidation: { status: 'unconfigured' } })
  const expected: number[] = []
  server.use(
    http.get('/api/management/workspaces/workspace-1', () => HttpResponse.json(workspace(2))),
    http.delete('/api/management/workspaces/workspace-1', async ({ request }) => {
      const body = await request.json() as { expectedRevision: number }
      expected.push(body.expectedRevision)
      if (body.expectedRevision !== 2) {
        return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'The workspace changed.' } }, { status: 409 })
      }
      return HttpResponse.json({ value: workspace(3), replayed: false })
    }),
  )
  const user = userEvent.setup()
  renderWithRouter(<RemoveWorkspaceButton workspaceId="workspace-1" name="Website" revision={1} />)
  await user.click(screen.getByRole('button', { name: 'Remove workspace' }))
  const dialog = screen.getByRole('alertdialog', { name: 'Remove Website?' })
  await user.click(within(dialog).getByRole('button', { name: 'Remove workspace' }))
  expect(await within(dialog).findByText('The workspace changed.')).toBeVisible()
  await user.click(within(dialog).getByRole('button', { name: 'Remove workspace' }))
  await waitFor(() => expect(expected).toEqual([1, 2]))
})

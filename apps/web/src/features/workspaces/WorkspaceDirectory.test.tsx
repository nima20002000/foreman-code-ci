import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { HttpResponse, http } from 'msw'
import { afterEach, describe, expect, it, vi } from 'vitest'

import { renderWithRouter } from '../../test/renderWithRouter'
import { server } from '../../mocks/server'
import { WorkspaceDirectory } from './WorkspaceDirectory'

afterEach(() => {
  vi.unstubAllEnvs()
  sessionStorage.clear()
})

describe('WorkspaceDirectory', () => {
  it('sends an unauthenticated browser to App access', async () => {
    vi.stubEnv('MODE', 'development')
    server.use(http.get('/api/management/workspaces', () => HttpResponse.json({
      error: { code: 'AUTH_REQUIRED', message: 'A bearer credential is required.' },
    }, { status: 401 })))
    renderWithRouter(<WorkspaceDirectory />)

    expect(await screen.findByText('Workspaces unavailable')).toBeVisible()
    expect(screen.getByText('Check the local API connection, then retry the workspace list.')).toBeVisible()
    expect(screen.queryByRole('link', { name: 'Open App access' })).not.toBeInTheDocument()
  })

  it('lists durable workspaces as simple cards', async () => {
    renderWithRouter(<WorkspaceDirectory />)

    expect(
      within(await screen.findByTestId('workspace-card-workspace-1'))
        .getByRole('link', { name: 'Website' }),
    ).toBeVisible()
    expect(screen.getByRole('button', { name: 'Open actions for Website' })).toBeVisible()
    await userEvent.setup().click(screen.getByRole('button', { name: 'New workspace' }))
    expect(screen.getByRole('dialog', { name: 'New workspace' })).toBeVisible()
  })

  it('shows an actionable empty state after every card is removed', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceDirectory />)

    await user.click(await screen.findByRole('button', { name: 'Open actions for Website' }))
    await user.click(screen.getByRole('button', { name: 'Remove workspace' }))
    await user.click(screen.getByRole('button', { name: 'Remove' }))

    const empty = within(await screen.findByTestId('workspace-directory-empty'))
    await user.click(empty.getByRole('button', { name: 'New workspace' }))
    expect(screen.getByRole('dialog', { name: 'New workspace' })).toBeVisible()
  })

  it('renames a workspace from its three-dot actions', async () => {
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceDirectory />)

    await user.click(await screen.findByRole('button', { name: 'Open actions for Website' }))
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Docs')
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    expect(await screen.findByTestId('workspace-card-workspace-1')).toHaveTextContent('Docs')
  })

  it('retries a rename that failed transiently with the same command ID', async () => {
    const commandIds: string[] = []
    server.use(http.patch('/api/management/workspaces/:workspaceId', async ({ request }) => {
      commandIds.push((await request.clone().json() as { commandId: string }).commandId)
      if (commandIds.length === 1) return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Restarting.' } }, { status: 503 })
      return undefined
    }))
    const user = userEvent.setup()
    renderWithRouter(<WorkspaceDirectory />)

    await user.click(await screen.findByRole('button', { name: 'Open actions for Website' }))
    await user.clear(screen.getByRole('textbox', { name: 'Name' }))
    await user.type(screen.getByRole('textbox', { name: 'Name' }), 'Docs')
    await user.click(screen.getByRole('button', { name: 'Rename' }))

    await waitFor(() => expect(screen.getByTestId('workspace-card-workspace-1')).toHaveTextContent('Docs'), { timeout: 4_000 })
    expect(commandIds).toHaveLength(2)
    expect(commandIds[1]).toBe(commandIds[0])
    expect(screen.queryByText('The last change may have worked.')).not.toBeInTheDocument()
  })
})

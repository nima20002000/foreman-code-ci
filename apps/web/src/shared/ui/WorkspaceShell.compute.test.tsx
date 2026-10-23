import { act, screen, within } from '@testing-library/react'
import { afterEach, expect, it } from 'vitest'
import { renderWithRouter } from '../../test/renderWithRouter'
import { useNavigationUiStore } from '../../features/workspaces/navigationUiStore'
import { WorkspaceShell } from './WorkspaceShell'

afterEach(() => act(() => useNavigationUiStore.getState().setCollapsed(false)))

it.each([false, true])('places both harness logos in the footer, with Settings under the product name, collapsed=%s', async collapsed => {
  act(() => useNavigationUiStore.getState().setCollapsed(collapsed))
  renderWithRouter(<WorkspaceShell workspaceId="workspace-1" />)
  const sidebar = await screen.findByRole('complementary', { name: 'Primary navigation' })
  expect(within(sidebar).getByRole('button', { name: 'Settings' })).toHaveTextContent('Foreman Code')
  expect(within(sidebar).queryByRole('button', { name: /Switch to .* theme/ })).not.toBeInTheDocument()
  expect(within(sidebar).queryByRole('button', { name: 'Workspace memory board' })).not.toBeInTheDocument()
  const claude = await within(sidebar).findByRole('button', { name: /^Claude:/ })
  expect(claude).toBeVisible()
  expect(within(claude.parentElement!).getByRole('button', { name: /^Codex:/ })).toBeVisible()
})

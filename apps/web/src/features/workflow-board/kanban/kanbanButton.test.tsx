// @vitest-environment jsdom
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../../../mocks/server'
import { KanbanButton } from './KanbanButton'

const path = '*/api/management/workspaces/workspace/workflows/workflow/kanban-layout'

it('says the layout could not be read and lets the person retry instead of staying disabled', async () => {
  let reads = 0
  server.use(http.get(path, () => {
    reads += 1
    if (reads === 1) return HttpResponse.json({ error: { code: 'INTERNAL', message: 'Layout store is down' } }, { status: 500 })
    return HttpResponse.json({ workspaceId: 'workspace', workflowId: 'workflow', layout: { visible: false, frame: null } })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><KanbanButton workspaceId="workspace" workflowId="workflow" /></QueryClientProvider>)
  const toggle = await screen.findByRole('button', { name: 'Kanban' })
  await waitFor(() => expect(toggle).toBeEnabled())
  expect(toggle).toHaveAttribute('title', expect.stringContaining('Layout store is down'))
  await userEvent.click(toggle)
  await waitFor(() => expect(reads).toBe(2))
  await waitFor(() => expect(toggle).toHaveAttribute('title', 'Add the Kanban to the Board'))
})

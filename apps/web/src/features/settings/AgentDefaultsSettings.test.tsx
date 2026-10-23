import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { useOperatorChatStore } from '../operator-chat/operatorChatStore'
import { AgentDefaultsSettings } from './AgentDefaultsSettings'

const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); useOperatorChatStore.getState().reset() })
function mount(props: Parameters<typeof AgentDefaultsSettings>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><AgentDefaultsSettings {...props} /></QueryClientProvider>)
}
function card(name: string) { return screen.getByRole('button', { name: `Edit ${name} defaults` }).closest('.settings-choice') as HTMLElement }

it('shows each role as a summary card that opens its own editor', async () => {
  server.use(http.get('/api/management/settings/agents', () => HttpResponse.json({ revision: 3, versionId: null, value: DEFAULT_AGENT_DEFAULTS })))
  const opened: unknown[] = []
  mount({ onOpen: role => opened.push(role) })
  await screen.findByRole('button', { name: 'Edit Worker defaults' })
  for (const role of ['Operator', 'Master', 'Orchestrator', 'Worker']) expect(within(card(role)).getByText('Model')).toBeVisible()
  expect(within(card('Worker')).getByText('Foreman Code; apps off')).toBeVisible()
  expect(within(card('Orchestrator')).getByText('Foreman Code; apps off')).toBeVisible()
  expect(within(card('Operator')).getByText('Host MCP servers; apps inherit host settings')).toBeVisible()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Edit Worker defaults' }))
  expect(opened).toEqual(['coder'])
  expect(useOperatorChatStore.getState().request).toBeUndefined()
})

it('edits a role in place and saves it with the read revision', async () => {
  const saved: Array<{ expectedRevision: number; value: typeof DEFAULT_AGENT_DEFAULTS }> = []
  let value = DEFAULT_AGENT_DEFAULTS
  server.use(
    http.get('/api/management/settings/agents', () => HttpResponse.json({ revision: 3 + saved.length, versionId: null, value })),
    http.put('/api/management/settings/agents', async ({ request }) => {
      const body = await request.json() as typeof saved[number]; saved.push(body); value = body.value
      return HttpResponse.json({ value: { revision: 3 + saved.length, versionId: null, value }, replayed: false })
    }),
  )
  mount({ selectedRole: 'coder' })
  const user = userEvent.setup()
  const memory = await screen.findByRole('combobox', { name: 'Memory board' })
  expect(memory).toHaveValue('write')
  // Memory on means read and write; only a workflow node or read-only access narrows it.
  expect(within(memory).getAllByRole('option').map(option => option.textContent)).toEqual(['Off', 'Read and write'])
  await user.selectOptions(memory, 'none')
  await user.click(screen.getByRole('button', { name: 'Save Worker settings' }))
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(saved[0]!.expectedRevision).toBe(3)
  expect(saved[0]!.value.coder.graphqlTools?.some(tool => tool.startsWith('memory_'))).toBe(false)
  expect(await screen.findByText('Saved.')).toBeVisible()
})

it('saves Operator chat visibility directly with the read revision', async () => {
  const saved: Array<{ expectedRevision: number; value: typeof DEFAULT_AGENT_DEFAULTS }> = []
  let value = DEFAULT_AGENT_DEFAULTS
  server.use(
    http.get('/api/management/settings/agents', () => HttpResponse.json({ revision: 3 + saved.length, versionId: null, value })),
    http.put('/api/management/settings/agents', async ({ request }) => {
      const body = await request.json() as typeof saved[number]; saved.push(body); value = body.value
      return HttpResponse.json({ value: { revision: 3 + saved.length, versionId: null, value }, replayed: false })
    }),
  )
  mount()
  const toggle = await within(await waitFor(() => card('Operator'))).findByRole('switch', { name: 'Show Operator chat' })
  expect(toggle).toBeChecked()
  await userEvent.click(toggle)
  await waitFor(() => expect(saved).toHaveLength(1))
  expect(saved[0]).toMatchObject({ expectedRevision: 3, value: { operator: { uiEnabled: false } } })
  await waitFor(() => expect(toggle).not.toBeChecked())
})

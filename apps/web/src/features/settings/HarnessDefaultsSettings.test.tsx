import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { afterEach, expect, it, vi } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { queryKeys } from '../../shared/api/query'
import { accountTarget, accountTargetInfo, observedAccount, workerAccountTarget } from '../provider-accounts/providerAccounts.fixtures'
import { providerTargetsKey, providerAccountsKey } from '../provider-accounts'
import { mockRuntimeIdentity } from '../../shared/mocks/handlers'
import { useOperatorChatStore } from '../operator-chat'
import { HarnessDefaultsSettings } from './HarnessDefaultsSettings'
import { clearRevisionedFormPersistence } from './revisionedForm'
import { savedClaudeConfiguration } from './claudeSettings.fixtures'

vi.mock('./OperatorMcpStatus', () => ({ OperatorMcpStatus: ({ harness }: { harness: string }) => <span>Operator MCP for {harness}</span> }))
vi.mock('./CodexPluginManager', () => ({ CodexPluginManager: () => <p>Plugin catalog</p> }))
vi.mock('./ClaudePluginSummary', () => ({ ClaudePluginSummary: () => <p>Claude plugin summary</p> }))
vi.mock('./HarnessMcpManager', () => ({ HarnessMcpManager: () => <p>Native connections</p> }))

const clients: QueryClient[] = []
afterEach(() => { cleanup(); for (const client of clients.splice(0)) client.clear(); clearRevisionedFormPersistence(); useOperatorChatStore.getState().reset() })
function mount(props: Parameters<typeof HarnessDefaultsSettings>[0] = {}) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false, staleTime: Infinity } } }); clients.push(client)
  client.setQueryData(['workbench', 'runtime-identity', 0], mockRuntimeIdentity)
  client.setQueryData(providerTargetsKey(), { targets: [accountTargetInfo()] })
  for (const provider of ['codex', 'claude'] as const) {
    client.setQueryData(providerAccountsKey({ provider, target: accountTarget, generation: 1, includeRemoved: true }),
      { revision: 1, accounts: [] })
  }
  client.setQueryData(queryKeys.managedHarnessCatalog, Object.entries({ ...DEFAULT_HARNESS_DEFAULTS, claude: savedClaudeConfiguration })
    .map(([harness, defaults]) => ({ harness, defaults, defaultsRevision: 4,
      capability: harness === 'codex' ? { ready: true } : null,
      discoveryError: harness === 'claude' ? { code: 'CLAUDE_PROFILE_SELECTION_REQUIRED', message: 'Check the Claude profile.' } : null })))
  render(<QueryClientProvider client={client}><HarnessDefaultsSettings {...props} /></QueryClientProvider>)
  return client
}

it('shows Codex and Claude as summary cards with status and no editor', () => {
  mount()
  const codex = screen.getByRole('button', { name: 'Edit Codex defaults' }).closest('.settings-choice') as HTMLElement
  const claude = screen.getByRole('button', { name: 'Edit Claude defaults' }).closest('.settings-choice') as HTMLElement
  expect(within(codex).getByText('Ready')).toBeVisible()
  expect(within(claude).getByText('Unavailable')).toBeVisible()
  expect(within(codex).getByText('Operator MCP for codex')).toBeVisible()
  expect(within(codex).getByRole('region', { name: 'Codex accounts' })).toBeVisible()
  expect(within(claude).getByRole('region', { name: 'Claude accounts' })).toBeVisible()
  expect(within(screen.getByRole('button', { name: 'Edit Codex defaults' })).queryByText('Accounts')).not.toBeInTheDocument()
  expect(screen.queryByText('OpenCode')).not.toBeInTheDocument()
  expect(screen.queryByRole('combobox')).not.toBeInTheDocument()
  expect(screen.queryByRole('textbox')).not.toBeInTheDocument()
})

it('drafts a preset change for the Operator and opens Codex panels', async () => {
  const onOpen = vi.fn()
  mount({ onOpen })
  await userEvent.click(screen.getByRole('button', { name: 'Edit Codex defaults' }))
  expect(useOperatorChatStore.getState().request).toMatchObject({ content: 'Change the Codex preset: ', send: false })
  await userEvent.click(screen.getAllByRole('button', { name: 'Plugins' })[0]!)
  expect(onOpen).toHaveBeenLastCalledWith({ harness: 'codex', section: 'plugins' })
  await userEvent.click(within(screen.getByRole('button', { name: 'Edit Codex defaults' }).closest('.settings-choice') as HTMLElement).getByRole('button', { name: 'Connections' }))
  expect(onOpen).toHaveBeenLastCalledWith({ harness: 'codex', section: 'connections' })
})

it.each([['plugins', 'Codex plugins', 'Plugin catalog'], ['connections', 'Codex connections', 'Native connections']] as const)(
  'shows the %s panel in a dialog from the URL', (section, title, content) => {
    mount({ selectedHarness: 'codex', section })
    expect(within(screen.getByRole('dialog', { name: title })).getByText(content)).toBeVisible()
  })

it('opens the Claude plugin summary from its card and URL', async () => {
  const onOpen = vi.fn()
  mount({ selectedHarness: 'claude', section: 'plugins', onOpen })
  expect(within(screen.getByRole('dialog', { name: 'Claude plugins' })).getByText('Claude plugin summary')).toBeVisible()
  const card = screen.getByRole('button', { name: 'Edit Claude defaults' }).closest('.settings-choice') as HTMLElement
  await userEvent.click(within(card).getByRole('button', { name: 'Plugins' }))
  expect(onOpen).toHaveBeenLastCalledWith({ harness: 'claude', section: 'plugins' })
})


it('keeps account controls in each card footer and independent of preset navigation', async () => {
  server.use(http.get('/api/local-human', () => HttpResponse.json({ principal: {
    id: 'account-settings-browser', name: 'Test browser', expiresAt: '2099-01-01T00:00:00Z',
    grants: [{ actions: ['provider_accounts:read', 'provider_accounts:manage'], scope: {} }],
  } })))
  mount()
  for (const harness of ['Codex', 'Claude']) {
    const edit = screen.getByRole('button', { name: `Edit ${harness} defaults` })
    const row = edit.closest('.settings-choice') as HTMLElement
    const add = within(row).getByRole('button', { name: `Add ${harness} account` })
    await waitFor(() => expect(add).toBeEnabled())
    expect(edit.contains(add)).toBe(false)
  }
  const user = userEvent.setup()
  await user.click(screen.getByRole('button', { name: 'Add Claude account' }))
  expect(screen.getByRole('dialog', { name: 'Add Claude account' })).toBeVisible()
  expect(useOperatorChatStore.getState().request).toBeUndefined()
})

it.each([
  [503, 'Claude accounts could not update'],
  [500, 'Claude accounts could not update'],
] as const)('keeps the other card, presets and panels usable after one account read fails with HTTP %s', async (status, message) => {
  server.use(http.get('/api/provider-accounts/page', ({ request }) => {
    if (new URL(request.url).searchParams.get('provider') === 'claude') return HttpResponse.json({
      error: { code: 'UNAVAILABLE', message: 'Claude accounts could not update' },
    }, { status })
    return HttpResponse.json({ target: accountTarget, revision: 2, accounts: [observedAccount()], defaults: [], nextCursor: null })
  }))
  const client = mount()
  await act(async () => { await client.invalidateQueries({ queryKey: ['provider-accounts'] }) })
  const codex = screen.getByRole('button', { name: 'Edit Codex defaults' }).closest('.settings-choice') as HTMLElement
  const claude = screen.getByRole('button', { name: 'Edit Claude defaults' }).closest('.settings-choice') as HTMLElement
  expect(await within(codex).findByRole('article', { name: 'Original account account' })).toBeVisible()
  expect(await within(claude).findByText(message)).toBeVisible()
  expect(within(claude).getByRole('button', { name: 'Retry accounts' })).toBeEnabled()
  expect(within(codex).queryByRole('button', { name: 'Retry accounts' })).not.toBeInTheDocument()
  expect(within(codex).getByRole('button', { name: 'Connections' })).toBeEnabled()
  expect(within(claude).getByRole('button', { name: 'Plugins' })).toBeEnabled()
  expect(within(codex).getByText('Ready')).toBeVisible()
})

it('uses discovered canonical targets for both account cards without placing controls inside the preset buttons', async () => {
  const onAccountTargetChange = vi.fn()
  const client = mount({ accountTarget: workerAccountTarget, onAccountTargetChange })
  await act(async () => { client.setQueryData(providerTargetsKey(), {
    targets: [accountTargetInfo(), accountTargetInfo(workerAccountTarget)],
  }) })
  const picker = await screen.findByRole('combobox', { name: 'Account computer' })
  expect(picker).toHaveValue(JSON.stringify(workerAccountTarget))
  for (const harness of ['Codex', 'Claude']) {
    expect(screen.getByRole('button', { name: `Edit ${harness} defaults` }).contains(picker)).toBe(false)
  }
  await userEvent.selectOptions(picker, JSON.stringify(accountTarget))
  expect(onAccountTargetChange).toHaveBeenCalledWith(accountTarget)
  expect(screen.getAllByRole('combobox', { name: /account computer/i })).toHaveLength(1)
})


it.each([422, 503])('exposes recovery for an Operator default save rejected with HTTP %s', async status => {
  const requests: unknown[] = []
  server.use(
    http.get('/api/management/settings/agents', () => HttpResponse.json({ revision: 3, versionId: null, value: DEFAULT_AGENT_DEFAULTS })),
    http.put('/api/management/settings/agents', async ({ request }) => {
      const input = await request.json() as { value: typeof DEFAULT_AGENT_DEFAULTS }; requests.push(input)
      return requests.length === 1
        ? HttpResponse.json({ error: { code: status === 503 ? 'UNAVAILABLE' : 'INVALID_INPUT', message: 'Default save failed' } }, { status })
        : HttpResponse.json({ replayed: false, value: { revision: 4, versionId: null, value: input.value } })
    }),
  )
  mount()
  const card = screen.getByRole('button', { name: 'Edit Claude defaults' }).closest('.settings-choice') as HTMLElement
  const toggle = within(card).getByRole('switch', { name: 'Operator default' })
  await waitFor(() => expect(toggle).toBeEnabled())
  await userEvent.click(toggle)
  expect(await screen.findByText(/Operator default has unsaved changes/)).toBeVisible()
  if (status === 422) {
    expect(await screen.findByText(/Default save failed/)).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Discard' }))
    expect(toggle).not.toBeChecked()
  } else {
    expect(await screen.findByText(/Save not confirmed/)).toBeVisible()
    await userEvent.click(screen.getByRole('button', { name: 'Save Operator default' }))
    await waitFor(() => expect(requests).toHaveLength(2))
    expect(requests[1]).toEqual(requests[0])
    expect(await screen.findByText('Saved.')).toBeVisible()
  }
})


it('opens Claude MCP configuration from a connection deep link', async () => {
  mount({ selectedHarness: 'claude', section: 'connections' })
  expect(await screen.findByRole('dialog', { name: 'Claude connections' })).toBeVisible()
  expect(screen.getByRole('region', { name: 'Claude MCP configuration' })).toBeVisible()
})

it.each(['model', 'permissions', 'session', 'tools', 'workspace'] as const)('explains the supported destination of a %s preset deep link', async section => {
  mount({ selectedHarness: 'claude', section })
  const panel = await screen.findByRole('dialog', { name: `Claude ${section}` })
  expect(within(panel).getByRole('button', { name: 'Edit Claude defaults with Operator' })).toBeVisible()
})


it('uses one global computer picker for both harness account lists', async () => {
  const client = mount({ accountTarget: workerAccountTarget, onAccountTargetChange: vi.fn() })
  await act(async () => { client.setQueryData(providerTargetsKey(), { targets: [accountTargetInfo(), accountTargetInfo(workerAccountTarget)] }) })
  const picker = await screen.findByRole('combobox', { name: 'Account computer' })
  expect(picker).toHaveValue(JSON.stringify(workerAccountTarget))
  expect(screen.getAllByRole('combobox', { name: /account computer/i })).toHaveLength(1)
  expect(screen.getByRole('region', { name: 'Codex accounts' }).contains(picker)).toBe(false)
  expect(screen.getByRole('region', { name: 'Claude accounts' }).contains(picker)).toBe(false)
})

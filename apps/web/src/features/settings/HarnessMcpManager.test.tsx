import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, fireEvent, render, screen, waitFor, within } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { HarnessMcpManager } from './HarnessMcpManager'
import { harnessSettingsKeys } from '../../shared/api/harnessSettings'
import type { HarnessMcpPlan } from '@foreman-code/contracts/management'

const revision = 'sha256:' + 'a'.repeat(64)
const checkedAt = '2026-09-20T00:00:00.000Z'
const clients: QueryClient[] = []
afterEach(() => { cleanup(); clients.splice(0).forEach((client) => client.clear()) })

/** The suggested-server row for one preset, e.g. "Foreman Code MCP". */
const presetRow = (label: string) => within(screen.getByText(label).closest('.harness-preset-row') as HTMLElement)
/** Buttons stay disabled while a read or change is in flight; click once they are ready. */
async function clickWhenEnabled(name: string) {
  const button = await screen.findByRole('button', { name })
  await waitFor(() => expect(button).toBeEnabled())
  fireEvent.click(button)
}

it.each([500, 503])('shows HTTP %s refresh failures and disables writes until an inspection succeeds', async (status) => {
  let unavailable = false
  const message = 'Couldn\'t read servers.'
  server.use(
    http.get('/api/management/harnesses/codex/mcp', () => unavailable
      ? HttpResponse.json({ error: { code: 'HARNESS_QUALIFICATION_FAILED', message: 'Native inspection unavailable' } }, { status })
      : HttpResponse.json({ harness: 'codex', revision, checkedAt, scope: 'native-user', servers: [],
        presets: { graphql: 'missing', linear: 'missing' } })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => HttpResponse.json({ items: [] })),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><HarnessMcpManager harness="codex" /></QueryClientProvider>)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Add server' })).toBeEnabled())
  unavailable = true
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  expect(await screen.findByText(message)).toBeVisible()
  expect(screen.getByRole('button', { name: 'Add server' })).toBeDisabled()
  unavailable = false
  fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  await waitFor(() => expect(screen.queryByText(message)).not.toBeInTheDocument())
  expect(screen.getByRole('button', { name: 'Add server' })).toBeEnabled()
})

it.each(['codex'] as const)('adds, toggles, and removes Foreman Code and Linear MCP in %s', async (harness) => {
  const installed = new Map<string, boolean>()
  const calls: Array<{ preset: string; installed?: boolean; enabled?: boolean }> = []
  server.use(
    http.get(`/api/management/harnesses/${harness}/mcp`, () => HttpResponse.json({ harness, revision, checkedAt, scope: 'native-user',
      servers: [...installed].map(([name, enabled]) => ({ name, transport: 'remote', label: name === 'linear' ? 'mcp.linear.app' : '127.0.0.1:3000',
        endpoint: name === 'linear' ? 'https://mcp.linear.app/mcp/readonly' : 'http://127.0.0.1:3000/mcp',
        enabled, origin: 'user', protected: name !== 'linear', editable: name === 'linear' })),
      presets: { graphql: installed.has('foreman-code') ? installed.get('foreman-code') ? 'installed' : 'disabled' : 'missing',
        linear: installed.has('linear') ? installed.get('linear') ? 'installed' : 'disabled' : 'missing' },
    })),
    http.get(`/api/management/harnesses/${harness}/mcp/plans`, () => HttpResponse.json({ items: [] })),
    http.post('/api/management/harnesses/mcp/managed', async ({ request }) => {
      const input = await request.json() as { preset: string; installed?: boolean; enabled?: boolean }
      calls.push(input)
      const name = input.preset === 'graphql' ? 'foreman-code' : 'linear'
      if (input.enabled !== undefined) installed.set(name, input.enabled)
      else if (input.installed) installed.set(name, true); else installed.delete(name)
      return HttpResponse.json({ id: crypto.randomUUID(), harness, revision, change: { kind: input.enabled !== undefined ? 'enable' : input.installed ? 'add' : 'remove', name,
        ...(input.enabled !== undefined ? { enabled: input.enabled } : input.installed ? { connection: { transport: 'remote', url: name === 'linear' ? 'https://mcp.linear.app/mcp/readonly' : 'http://127.0.0.1:3000/mcp' } } : {}) },
      managedPreset: input.preset, requestedBy: 'owner', status: 'applied', createdAt: checkedAt, expiresAt: checkedAt, error: null })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><HarnessMcpManager harness={harness} /></QueryClientProvider>)
  for (const [name, label] of [['foreman-code', 'Foreman Code MCP'], ['linear', 'Linear MCP']] as const) {
    const add = await presetRow(label).findByRole('button', { name: 'Add' })
    await waitFor(() => expect(add).toBeEnabled())
    fireEvent.click(add)
    const card = await screen.findByRole('button', { name: `View details for ${name}, Enabled` })
    fireEvent.click(card)
    const details = screen.getByRole('region', { name: 'codex MCP connections' })
    expect(within(details).getByRole('heading', { name })).toBeVisible()
    expect(within(details).getByText(name === 'linear' ? 'https://mcp.linear.app/mcp/readonly' : 'http://127.0.0.1:3000/mcp')).toBeVisible()
    await clickWhenEnabled('Disable')
    await waitFor(() => expect(details).toHaveTextContent('Disabled'))
    expect(screen.getByRole('button', { name: 'Remove' })).toBeVisible()
    await clickWhenEnabled('Enable')
    await waitFor(() => expect(details).toHaveTextContent('Enabled'))
    await clickWhenEnabled('Remove')
    await waitFor(() => expect(presetRow(label).getByRole('button', { name: 'Add' })).toBeEnabled())
  }
  expect(calls.map(({ preset, installed, enabled }) => [preset, installed, enabled])).toEqual([
    ['graphql', true, undefined], ['graphql', undefined, false], ['graphql', undefined, true], ['graphql', false, undefined],
    ['linear', true, undefined], ['linear', undefined, false], ['linear', undefined, true], ['linear', false, undefined],
  ])
})

it('keeps the original command identity when a one-click response is uncertain', async () => {
  const inputs: Array<{ commandId: string }> = []
  server.use(
    http.get('/api/management/harnesses/codex/mcp', () => HttpResponse.json({ harness: 'codex', revision, checkedAt, scope: 'native-user', servers: [],
      presets: { graphql: 'missing', linear: 'missing' } })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => HttpResponse.json({ items: [] })),
    http.post('/api/management/harnesses/mcp/managed', async ({ request }) => {
      const input = await request.json() as { commandId: string }; inputs.push(input)
      return inputs.length === 1 ? HttpResponse.json({ code: 'UNAVAILABLE', message: 'Response lost' }, { status: 503 })
        : HttpResponse.json({ id: crypto.randomUUID(), harness: 'codex', revision,
          change: { kind: 'add', name: 'graphql', connection: { transport: 'remote', url: 'http://127.0.0.1:3000/mcp' } },
          managedPreset: 'graphql', requestedBy: 'owner', status: 'applied', createdAt: checkedAt, expiresAt: checkedAt, error: null })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><HarnessMcpManager harness="codex" /></QueryClientProvider>)
  fireEvent.click(await presetRow('Foreman Code MCP').findByRole('button', { name: 'Add' }))
  fireEvent.click(await screen.findByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(inputs).toHaveLength(2))
  expect(inputs[1]?.commandId).toBe(inputs[0]?.commandId)
})

it('keeps protected and inherited servers inspectable while explaining why removal is unavailable', async () => {
  server.use(
    http.get('/api/management/harnesses/codex/mcp', () => HttpResponse.json({ harness: 'codex', revision, checkedAt, scope: 'native-user',
      servers: [
        { name: 'graphql', transport: 'remote', label: '127.0.0.1:3000', endpoint: 'http://127.0.0.1:3000/mcp', enabled: true, origin: 'user', protected: true, editable: false },
        { name: 'shared-tools', transport: 'stdio', label: 'tools', enabled: true, origin: 'inherited', protected: false, editable: false },
      ] })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => HttpResponse.json({ items: [] })),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><HarnessMcpManager harness="codex" /></QueryClientProvider>)
  const details = () => screen.getByRole('region', { name: 'codex MCP connections' })
  for (const name of ['graphql', 'shared-tools']) {
    fireEvent.click(await screen.findByRole('button', { name: `View details for ${name}, ${name === 'graphql' ? 'Enabled' : 'Inherited'}` }))
    if (name === 'graphql') expect(details()).toHaveTextContent('http://127.0.0.1:3000/mcp')
    expect(screen.queryByRole('button', { name: 'Remove' })).not.toBeInTheDocument()
    expect(details()).toHaveTextContent(name === 'graphql' ? 'Managed by Foreman Code.' : 'Change it in the config file it comes from.')
    expect(screen.queryByRole('button', { name: /^(Enable|Disable)$/ })).not.toBeInTheDocument()
    fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  }
})

it('upgrades retired graphql-app and graphql-operator entries to the one Foreman Code MCP', async () => {
  const inputs: Array<{ preset: string; installed?: boolean }> = []
  server.use(
    http.get('/api/management/harnesses/codex/mcp', () => HttpResponse.json({ harness: 'codex', revision, checkedAt, scope: 'native-user',
      servers: ['graphql-app', 'graphql-operator'].map((name) => ({ name, transport: 'stdio', label: 'Legacy app connection · replaced by graphql',
        enabled: true, origin: 'user', protected: true, editable: false })),
      presets: { graphql: 'legacy', linear: 'missing' } })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => HttpResponse.json({ items: [] })),
    http.post('/api/management/harnesses/mcp/managed', async ({ request }) => {
      const input = await request.json() as { preset: string; installed?: boolean }; inputs.push(input)
      return HttpResponse.json({ id: crypto.randomUUID(), harness: 'codex', revision,
        change: { kind: 'add', name: 'graphql', connection: { transport: 'stdio', executable: '/usr/bin/node', arguments: ['/launcher.mjs'], environmentVariables: [] } },
        managedPreset: 'graphql', requestedBy: 'owner', status: 'applied', createdAt: checkedAt, expiresAt: checkedAt, error: null })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><HarnessMcpManager harness="codex" /></QueryClientProvider>)
  const upgrade = await presetRow('Foreman Code MCP').findByRole('button', { name: 'Upgrade' })
  expect(screen.getByText('Replaces the two older app connections.')).toBeVisible()
  fireEvent.click(screen.getByRole('button', { name: 'View details for graphql-operator, Needs attention' }))
  expect(screen.getByRole('region', { name: 'codex MCP connections' })).toHaveTextContent('Retired. Use Upgrade to Foreman Code MCP to replace it.')
  fireEvent.click(screen.getByRole('button', { name: 'Back' }))
  await waitFor(() => expect(upgrade).toBeEnabled())
  fireEvent.click(await presetRow('Foreman Code MCP').findByRole('button', { name: 'Upgrade' }))
  await waitFor(() => expect(inputs).toEqual([expect.objectContaining({ preset: 'graphql', installed: true })]))
})

it('keeps native enablement behind the existing review flow in the details view', async () => {
  let planned: { change: { kind: string; enabled: boolean } } | undefined
  server.use(
    http.get('/api/management/harnesses/codex/mcp', () => HttpResponse.json({ harness: 'codex', revision, checkedAt, scope: 'native-user',
      servers: [{ name: 'mytools', transport: 'stdio', label: 'mytools', enabled: true, origin: 'user', protected: false, editable: true }],
      presets: { graphql: 'missing', linear: 'missing' } })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => HttpResponse.json({ items: [] })),
    http.post('/api/management/harnesses/mcp/plans', async ({ request }) => {
      planned = await request.json() as typeof planned
      return HttpResponse.json({ value: { id: crypto.randomUUID(), harness: 'codex', revision, change: planned?.change,
        requestedBy: 'owner', status: 'pending', createdAt: checkedAt, expiresAt: '2099-01-01T00:00:00.000Z', error: null }, replayed: false })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  render(<QueryClientProvider client={client}><HarnessMcpManager harness="codex" /></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'View details for mytools, Enabled' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Remove' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Disable' }))
  expect(await screen.findByRole('heading', { name: 'Review change' })).toBeVisible()
  expect(planned?.change).toMatchObject({ kind: 'enable', enabled: false })
})

it.each([500, 503])('adopts a plan settled by another session after HTTP %s while its uncertain review remains open', async (status) => {
  let plan: HarnessMcpPlan = {
    id: crypto.randomUUID(), harness: 'codex', revision,
    change: { kind: 'enable', name: 'mytools', enabled: false }, requestedBy: 'owner', status: 'pending',
    createdAt: checkedAt, expiresAt: '2099-01-01T00:00:00.000Z', error: null,
  }
  let decisions = 0
  let readbackFails = false
  server.use(
    http.get('/api/management/harnesses/codex/mcp', () => HttpResponse.json({ harness: 'codex', revision, checkedAt,
      scope: 'native-user', servers: [], presets: { graphql: 'missing', linear: 'missing' } })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => readbackFails
      ? HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Plan refresh failed' } }, { status })
      : HttpResponse.json({ items: [plan] })),
    http.post('/api/management/harnesses/mcp/decision', () => {
      decisions++
      plan = { ...plan, status: 'uncertain', error: 'The native response was lost.' }
      readbackFails = true
      return HttpResponse.json(plan)
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  render(<QueryClientProvider client={client}><HarnessMcpManager harness="codex" /></QueryClientProvider>)
  fireEvent.click(await screen.findByRole('button', { name: 'Review' }))
  fireEvent.click(screen.getByRole('button', { name: 'Approve and apply' }))
  expect(await screen.findByText('Change uncertain')).toBeVisible()
  expect(screen.getByRole('button', { name: 'Confirm change' })).toBeVisible()
  plan = { ...plan, status: 'applied', error: null }
  readbackFails = false
  await client.invalidateQueries({ queryKey: harnessSettingsKeys.plans('codex') })
  expect(await screen.findByText('Change applied')).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Confirm change' })).not.toBeInTheDocument()
  expect(decisions).toBe(1)
})

it.each(['parent', 'native'] as const)('locks an uncertain retry during %s access denial and keeps its original request', async (source) => {
  let nativeDenied = false
  const inputs: unknown[] = []
  server.use(
    http.get('/api/management/harnesses/codex/mcp', () => nativeDenied
      ? HttpResponse.json({ error: { code: 'ACCESS_DENIED', message: 'Connection access was removed' } }, { status: 403 })
      : HttpResponse.json({ harness: 'codex', revision, checkedAt, scope: 'native-user', servers: [],
        presets: { graphql: 'missing', linear: 'missing' } })),
    http.get('/api/management/harnesses/codex/mcp/plans', () => HttpResponse.json({ items: [] })),
    http.post('/api/management/harnesses/mcp/managed', async ({ request }) => {
      inputs.push(await request.json())
      return HttpResponse.json({ error: { code: 'UNAVAILABLE', message: 'Response lost' } }, { status: 503 })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const panel = (accessUnavailable: boolean) => <QueryClientProvider client={client}>
    <HarnessMcpManager harness="codex" accessUnavailable={accessUnavailable} />
  </QueryClientProvider>
  const mounted = render(panel(false))
  fireEvent.click(await presetRow('Foreman Code MCP').findByRole('button', { name: 'Add' }))
  await screen.findByRole('button', { name: 'Retry' })
  expect(inputs).toHaveLength(1)
  if (source === 'parent') mounted.rerender(panel(true))
  else {
    nativeDenied = true
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  }
  await screen.findByText('Connections are unavailable right now.')
  const retry = screen.getByRole('button', { name: 'Retry' })
  expect(retry).toBeDisabled()
  fireEvent.click(retry)
  expect(inputs).toHaveLength(1)
  if (source === 'parent') mounted.rerender(panel(false))
  else {
    nativeDenied = false
    fireEvent.click(screen.getByRole('button', { name: 'Refresh' }))
  }
  await waitFor(() => expect(screen.getByRole('button', { name: 'Retry' })).toBeEnabled())
  fireEvent.click(screen.getByRole('button', { name: 'Retry' }))
  await waitFor(() => expect(inputs).toHaveLength(2))
  expect(inputs[1]).toEqual(inputs[0])
})

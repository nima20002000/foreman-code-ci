import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it, vi } from 'vitest'
import { server } from '../../mocks/server'
import { ClaudePluginSummary } from './ClaudePluginSummary'
import { CodexPluginManager } from './CodexPluginManager'

const navigation = vi.hoisted(() => vi.fn())
const search = vi.hoisted(() => ({ value: {} as Record<string, unknown> }))
vi.mock('@tanstack/react-router', () => ({
  useSearch: () => search.value,
  useNavigate: () => navigation,
}))

const clients: QueryClient[] = []
afterEach(() => {
  cleanup()
  for (const client of clients.splice(0)) client.clear()
})

it.each(['codex', 'codex plugin', 'claude'])('hides warm %s facts immediately when the parent loses read access', async harness => {
  search.value = harness === 'codex plugin' ? { pluginView: 'available', pluginId: 'notes@trusted' } : { pluginView: 'available' }
  const detail = harness === 'codex plugin'
  const revision = 'sha256:' + 'a'.repeat(64)
  const plugin = { pluginId: 'notes@trusted', name: 'notes', marketplaceName: 'trusted', version: '1',
    installed: false, enabled: false, sourceType: 'remote', installPolicy: 'AVAILABLE', authPolicy: 'ON_USE' }
  let reads = 0
  server.use(
    http.get('/api/management/harnesses/codex/plugins/operations', () => {
      reads++
      return HttpResponse.json({ items: [] })
    }),
    http.get('/api/management/harnesses/codex/plugins/:pluginId', () => {
      reads++
      return HttpResponse.json({ plugin, revision, artifactIdentity: revision, contents: { status: 'unknown' } })
    }),
    http.get('/api/management/harnesses/codex/plugins', () => {
      reads++
      return HttpResponse.json({ items: [plugin], total: 1, nextOffset: null, revision,
        checkedAt: new Date().toISOString(), catalogStatus: 'complete', inventoryStatus: 'unknown' })
    }),
    http.get('/api/management/harnesses/claude/plugins', () => {
      reads++
      return HttpResponse.json({ items: [{ pluginId: plugin.pluginId, name: 'notes', marketplaceName: 'trusted',
        version: '1', description: null, installed: false, enabled: false, installCount: null }],
      total: 1, nextOffset: null, revision: 'a'.repeat(64), checkedAt: new Date().toISOString(), marketplaces: [] })
    }),
  )
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  clients.push(client)
  const show = (accessUnavailable: boolean) => <QueryClientProvider client={client}>
    {harness !== 'claude' ? <CodexPluginManager accessUnavailable={accessUnavailable} />
      : <ClaudePluginSummary accessUnavailable={accessUnavailable} onClose={vi.fn()} />}
  </QueryClientProvider>
  const view = render(show(false))
  const cardName = harness === 'claude' ? 'Ask Operator to install notes' : 'View notes plugin, available'
  if (detail) await waitFor(() => expect(screen.getByRole('button', { name: 'Install' })).toBeEnabled())
  else await screen.findByRole('button', { name: cardName })
  const initialReads = reads
  view.rerender(show(true))
  expect(screen.queryByRole('button', { name: cardName })).not.toBeInTheDocument()
  expect(screen.queryByRole('button', { name: 'Install' })).not.toBeInTheDocument()
  if (detail) {
    expect(screen.getByText('Plugins are unavailable right now.')).toBeVisible()
    expect(screen.queryByText('trusted')).not.toBeInTheDocument()
  } else {
    expect(screen.getByRole('button', { name: 'Refresh' })).toBeDisabled()
    await userEvent.setup().click(screen.getByRole('button', { name: 'Refresh' }))
    if (harness === 'codex') expect(screen.getByText('Plugins are unavailable right now.')).toBeVisible()
    else expect(screen.getByRole('alert')).toHaveTextContent('Plugin access unavailable')
  }
  expect(reads).toBe(initialReads)
})

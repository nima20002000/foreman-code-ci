import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { WorkspaceRootSelection } from '@foreman-code/contracts/workspace-root-policies'
import type { WorkspaceBoundLocationReadback } from '@foreman-code/contracts/workspace-bound-location'
import { server } from '../../mocks/server'
import { mainTarget, deviceTarget, mainId } from '../computers/computersTestFixture'
import { WorkspaceExecutionLocationSettings } from './WorkspaceExecutionLocationSettings'
import { useBoundLocationDraftStore } from './workspaceBoundLocationDraftStore'
import { mainRoot, workerRoot, rootAttestation, boundRootReadback, rootSetReadback } from './workspaceBoundLocation.fixtures'
const clients: QueryClient[] = []
let saved: WorkspaceBoundLocationReadback
function mount() { const client = new QueryClient({ defaultOptions: { queries: { retry: false } } }); clients.push(client)
  return render(<QueryClientProvider client={client}><WorkspaceExecutionLocationSettings workspaceId="workspace-1" /></QueryClientProvider>) }
async function choose(user: ReturnType<typeof userEvent.setup>, remote = true) {
  await user.click(await screen.findByRole('button', { name: 'Project folder' }))
  const select = await screen.findByRole('combobox', { name: 'Computer and folder' })
  const options = select.querySelectorAll('option')
  await user.selectOptions(select, options[remote ? 2 : 1]!.value)
}
beforeEach(() => {
  useBoundLocationDraftStore.getState().reset()
  saved = boundRootReadback({ workspaceId: 'workspace-1', hostRef: mainRoot.hostRef,
    allowedBaseId: mainRoot.bases[0]!.baseId, configurationRevision: '1', relativePath: 'previous',
    accessMode: 'read-write', expectedLocationRevision: 0, expectedRootPolicyRevision: 0 }, mainRoot)
  server.use(http.get('/api/management/workspaces/workspace-1/root-location', () => HttpResponse.json(saved)),
    http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({ workspaceId: 'workspace-1', readiness: 'metadata-only', policies: [], allowlists: [mainRoot, workerRoot] })),
    http.post('/api/management/workspaces/workspace-1/root-location/browse', async ({ request }) => { const input = await request.json() as WorkspaceRootSelection
      return HttpResponse.json({ workspaceId: input.workspaceId, selection: input, browse: { relativePath: input.relativePath, directories: [{ name: 'src', relativePath: 'src' }], truncated: false } }) }),
    http.post('/api/management/workspaces/workspace-1/root-location/validate', async ({ request }) => { const input = await request.json() as WorkspaceRootSelection
      return HttpResponse.json({ workspaceId: input.workspaceId, selection: input, attestation: rootAttestation(input, input.hostRef.kind === 'main' ? mainRoot : workerRoot), checkedAt: '2026-10-01T00:00:00.000Z' }) }))
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })
describe('authenticated target-local execution folder', () => {
  it.each(['browse', 'validate'])('allows dismissal during a pending %s read', async operation => {
    let release!: () => void
    const pending = new Promise<void>(resolve => { release = resolve })
    server.use(http.post(`/api/management/workspaces/workspace-1/root-location/${operation}`, async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection
      await pending
      return HttpResponse.json(operation === 'browse'
        ? { workspaceId: input.workspaceId, selection: input, browse: { relativePath: input.relativePath, directories: [], truncated: false } }
        : { workspaceId: input.workspaceId, selection: input, attestation: rootAttestation(input, workerRoot), checkedAt: '2026-10-01T00:00:00.000Z' })
    }))
    mount()
    const user = userEvent.setup()
    await choose(user)
    await user.click(screen.getByRole('button', { name: operation === 'browse' ? 'Browse' : 'Check folder' }))
    const cancel = screen.getByRole('button', { name: 'Cancel' })
    expect(cancel).toBeEnabled()
    await user.click(cancel)
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
    await act(async () => { release(); await pending })
    expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  })
  it('lets an invalid native folder selection be corrected after a definitive rejection', async () => {
    const writes: WorkspaceRootSelection[] = []
    server.use(http.put('/api/management/workspaces/workspace-1/root-location', async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection
      writes.push(input)
      if (input.relativePath === 'project/') return HttpResponse.json({
        error: { code: 'ROOT_RELATIVE_PATH_INVALID', message: 'Choose an unambiguous folder relative to an approved base.' },
      }, { status: 422 })
      saved = boundRootReadback(input, mainRoot)
      return HttpResponse.json({ value: saved, replayed: false })
    }))
    mount()
    const user = userEvent.setup()
    await choose(user, false)
    const field = screen.getByRole('textbox', { name: 'Subfolder' })
    await user.type(field, 'project/')
    await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    await waitFor(() => expect(screen.getAllByText('Choose an unambiguous folder relative to an approved base.').length)
      .toBeGreaterThan(0))
    expect(field).toBeEnabled()
    expect(screen.queryByRole('button', { name: 'Retry save' })).not.toBeInTheDocument()
    await user.clear(field)
    await user.type(field, 'project')
    await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    expect(writes.map(write => write.relativePath)).toEqual(['project/', 'project'])
  })
  it('browses and validates on the selected worker, then saves exact binding without a browser runner ID', async () => {
    const writes: WorkspaceRootSelection[] = []
    server.use(http.put('/api/management/workspaces/workspace-1/root-location', async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection; writes.push(input)
      expect(input.hostRef).toEqual(workerRoot.hostRef); expect(input.allowedBaseId).toBe(workerRoot.bases[0]!.baseId)
      expect(input).not.toHaveProperty('runnerId')
      saved = rootSetReadback(input, workerRoot)
      return HttpResponse.json({ value: saved, replayed: false })
    }))
    mount(); const user = userEvent.setup(); await choose(user)
    await user.click(screen.getByRole('button', { name: 'Browse' })); await user.click(await screen.findByRole('button', { name: 'src' }))
    await user.click(screen.getByRole('button', { name: 'Check folder' }))
    expect(await screen.findByText(/Folder checked on Worker computer/)).toHaveTextContent('Not saved yet.')
    await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    await waitFor(() => expect(screen.queryByRole('dialog', { name: 'Execution folder' })).not.toBeInTheDocument())
    expect(screen.getByText('Runs on').nextElementSibling).toHaveTextContent('Worker computer')
    expect(writes[0]).toMatchObject({ relativePath: 'src', expectedLocationRevision: 1, expectedRootPolicyRevision: 0 })
  })
  it('reconciles the original command and locks computer/path changes after a lost acknowledgement', async () => {
    const writes: unknown[] = []
    server.use(http.put('/api/management/workspaces/workspace-1/root-location', async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection; writes.push(input)
      if (writes.length === 1) return HttpResponse.json({ error: { code: 'INTERNAL', message: 'Acknowledgement lost.' } }, { status: 503 })
      expect(writes[1]).toEqual(writes[0])
      return HttpResponse.json({ value: rootSetReadback(input, workerRoot), replayed: true })
    }))
    mount(); const user = userEvent.setup(); await choose(user); await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    expect(await screen.findByText(/Not sure the last save went through/)).toBeVisible()
    expect(screen.getByRole('combobox', { name: 'Computer and folder' })).toBeDisabled()
    expect(screen.getByRole('textbox', { name: 'Subfolder' })).toBeDisabled()
    await user.click(screen.getAllByRole('button', { name: 'Retry save' })[0]!)
    await waitFor(() => expect(writes).toHaveLength(2))
  })
  it('keeps paths distinct when two computers have identical approved base paths', async () => {
    mount(); const user = userEvent.setup(); await choose(user, false)
    await user.type(screen.getByRole('textbox', { name: 'Subfolder' }), 'pc-only')
    const select = screen.getByRole('combobox', { name: 'Computer and folder' }); const options = select.querySelectorAll('option')
    await user.selectOptions(select, options[2]!.value)
    expect(screen.getByRole('textbox', { name: 'Subfolder' })).toHaveValue('')
    await user.type(screen.getByRole('textbox', { name: 'Subfolder' }), 'worker-only')
    await user.selectOptions(select, options[1]!.value)
    expect(screen.getByRole('textbox', { name: 'Subfolder' })).toHaveValue('pc-only')
  })
  it('shows denied root metadata and does not expose the local folder browser as a fallback', async () => {
    server.use(http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({ error: { code: 'FORBIDDEN', message: 'Root access denied.' } }, { status: 403 })))
    mount()
    expect(await screen.findByText('Couldn’t load the folder or the computers.')).toBeVisible()
    expect(screen.queryByRole('button', { name: 'Project folder' })).not.toBeInTheDocument()
  })
})

it('uses saved computer names in the chooser and exposes the full selected base folder', async () => {
  server.use(http.get('*/api/management/computers/activity', () => HttpResponse.json({ mainId,
    activityComplete: true, truncated: false, cloud: [], computers: [
      { target: mainTarget, name: 'Main PC', online: true, jobs: [], agents: [] },
      { target: deviceTarget, name: 'Studio computer', online: false, jobs: [], agents: [] },
    ] })))
  mount()
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Project folder' }))
  const select = await screen.findByRole('combobox', { name: 'Computer and folder' })
  const option = await within(select).findByRole('option', { name: 'Studio computer' })
  expect(within(select).getByRole('option', { name: 'Main PC' })).toBeInTheDocument()
  await user.selectOptions(select, option)
  expect(select).toHaveAccessibleDescription(workerRoot.bases[0]!.canonicalPath)
  expect(select).toHaveAttribute('title', workerRoot.bases[0]!.canonicalPath)
})

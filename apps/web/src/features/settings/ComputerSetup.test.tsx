import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, cleanup, render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it } from 'vitest'
import { SourceRootRecordSchema, type SourceRootSetupInput } from '@foreman-code/contracts/source-admission'
import type { SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import type { ApprovedRootAllowlist, WorkspaceRootSelection } from '@foreman-code/contracts/workspace-root-policies'
import { server } from '../../mocks/server'
import { boundLocationKeys } from '../../shared/api/workspaceBoundLocation'
import { mockRuntimeIdentity } from '../../shared/mocks/handlers'
import { WorkspaceExecutionLocationSettings } from './WorkspaceExecutionLocationSettings'
import { useBoundLocationDraftStore } from './workspaceBoundLocationDraftStore'
import { mainRoot, workerRoot, rootMainId, boundRootReadback, rootSetReadback } from './workspaceBoundLocation.fixtures'
import { NodePlacementField, usePlacementChoices } from '../node-placement'
import { savedPlacementFixture } from '../node-placement/fixtures'

const scope = { workspaceId: 'workspace-1', workflowId: 'workflow-1', nodeId: 'node-1', agentConfigurationVersionId: 'configuration-1' }
const main = boundRootReadback({ workspaceId: scope.workspaceId, hostRef: mainRoot.hostRef,
  allowedBaseId: mainRoot.bases[0]!.baseId, configurationRevision: '1', relativePath: 'main-project',
  accessMode: 'read-write', expectedLocationRevision: 0, expectedRootPolicyRevision: 0 }, mainRoot)
const placement = { ...savedPlacementFixture, hostRef: workerRoot.hostRef, projectRoot: '/projects/shared/studio-project' }
const clients: QueryClient[] = []
let writes: WorkspaceRootSelection[], reads: number, reason: string
let allowlists: ApprovedRootAllowlist[], adoptions: unknown[], setups: unknown[]
function AgentComputer() {
  const choices = usePlacementChoices(scope, 'setup-visit')
  const [value, onChange] = useState<SavedNodePlacement>()
  return <NodePlacementField workspaceId={scope.workspaceId} value={value} options={choices.options}
    unavailableComputers={choices.unavailableComputers} onChange={onChange} />
}
function mount(compact = false) {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  clients.push(client)
  return render(<QueryClientProvider client={client}>{compact
    ? <WorkspaceExecutionLocationSettings workspaceId={scope.workspaceId} presentation="compact" /> : <AgentComputer />}</QueryClientProvider>)
}
beforeEach(() => {
  useBoundLocationDraftStore.getState().reset()
  allowlists = [mainRoot, workerRoot]; adoptions = []; setups = []
  writes = []; reads = 0; reason = 'This workspace’s project isn’t set up on Studio yet.'
  server.use(
    http.get('/api/devices', () => HttpResponse.json({ devices: [{ mainId: rootMainId, deviceId: workerRoot.applicationInstallationId,
      workerInstallationId: workerRoot.applicationInstallationId, publicKeyFingerprint: 'a'.repeat(64),
      keyRevision: 1, authorizationRevision: 1, status: 'paired', scopes: ['connect', 'heartbeat'] }] })),
    http.post('/api/management/workspaces/workspace-1/root-configurations/adopt', async ({ request }) => {
      adoptions.push(await request.json()); allowlists = [mainRoot, workerRoot]
      return HttpResponse.json({ value: workerRoot, replayed: false })
    }),
    http.get('/api/management/harnesses/directories', () => HttpResponse.json({
      roots: [{ id: 'workspaces', label: 'Workspaces', path: '/projects/shared' }],
      rootId: null, path: null, parent: null, directories: [], nextCursor: null,
    })),
    http.get('/api/runtime/identity', () => HttpResponse.json({ ...mockRuntimeIdentity, installationId: rootMainId })),
    http.get('/api/management/settings/workspaces/creation', () => HttpResponse.json({ suggestedName: 'New workspace', description: '', parentPath: '/projects/shared' })),
    http.get('/api/management/workspaces/workspace-1/root-location', () => HttpResponse.json(main)),
    http.get('/api/management/workspaces/workspace-1/root-policies', () => HttpResponse.json({ workspaceId: scope.workspaceId,
      readiness: 'metadata-only', policies: [main.evidence === 'bound' ? main.binding : null,
        ...writes.map(input => rootSetReadback(input, workerRoot)).flatMap(value => value.evidence === 'bound' ? [value.binding] : [])],
      allowlists })),
    http.post('/api/management/workspaces/workspace-1/root-location/browse', async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection
      return HttpResponse.json({ workspaceId: scope.workspaceId, selection: input, browse: { relativePath: input.relativePath,
        directories: [{ name: 'studio-project', relativePath: 'studio-project' }], truncated: false } })
    }),
    http.put('/api/management/workspaces/workspace-1/root-location', async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection
      writes.push(input)
      return HttpResponse.json({ value: rootSetReadback(input, workerRoot), replayed: false })
    }),
    http.post('/api/management/workspaces/workspace-1/source-roots/setup', async ({ request }) => {
      const input = await request.json() as SourceRootSetupInput
      if ('hostRef' in input) return HttpResponse.json({ value: { kind: 'selection-required' }, replayed: false })
      setups.push(input)
      const binding = rootSetReadback(writes.at(-1)!, workerRoot)
      if (binding.evidence !== 'bound') throw new Error('Expected a saved folder')
      const id = '77777777-7777-4777-8777-777777777777', digest = 'a'.repeat(64)
      const value = SourceRootRecordSchema.parse({ version: 1, source: { approvedSourceId: id, snapshotId: id, manifestDigest: digest },
        selection: input.selection, binding: { version: 1, mainId: rootMainId, deviceId: workerRoot.applicationInstallationId,
          workerInstallationId: workerRoot.applicationInstallationId, workspaceId: scope.workspaceId, rootId: id, bindingRevision: 1,
          locationRevision: binding.locationRevision, canonicalPath: '/runtime/worker/source', filesystem: workerRoot.runtimeFilesystem,
          accessMode: 'exclusive-write', snapshotId: id, manifestDigest: digest }, ownerPrincipalId: 'owner', authorizedByPrincipalId: 'owner',
        registration: binding.binding.registration, attestationId: id, attestationDigest: digest, boundAt: '2030-01-01T00:00:00.000Z' })
      return HttpResponse.json({ value, replayed: false })
    }),
    http.get('/api/management/workspaces/workspace-1/workflows/workflow-1/nodes/node-1/placement-choices', () => {
      reads++
      return HttpResponse.json({ ...scope, pending: false,
        choices: setups.length ? [{ id: 'studio-choice', label: 'Studio · studio-project', placement, availability: 'ready', reason: null }] : [],
        unavailableComputers: setups.length ? [] : [{ hostRef: workerRoot.hostRef, name: 'Studio', reason }] })
    }),
  )
})
afterEach(() => { cleanup(); clients.splice(0).forEach(client => client.clear()) })

it.each([true, false])('sets up an unavailable Agent computer and refreshes placement choices (configuration adopted: %s)', async adopted => {
  if (!adopted) allowlists = [mainRoot]
  mount()
  const user = userEvent.setup()
  await user.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), await screen.findByRole('option', { name: 'Studio · unavailable' }))
  expect(screen.getByText(reason)).toBeVisible()
  await user.click(await screen.findByRole('button', { name: 'Set up on Studio' }))
  const dialog = await screen.findByRole('dialog', { name: 'Execution folder' })
  const computer = await within(dialog).findByRole('combobox', { name: 'Computer and folder' })
  await waitFor(() => expect(within(computer).getByRole('option', { selected: true })).toHaveTextContent('Worker computer'))
  await user.click(within(dialog).getByRole('button', { name: 'Browse' }))
  await user.click(await within(dialog).findByRole('button', { name: 'studio-project' }))
  await user.click(within(dialog).getByRole('button', { name: 'Use this folder' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(writes).toHaveLength(1)
  expect(adoptions).toEqual(adopted ? [] : [{ workspaceId: scope.workspaceId, hostRef: workerRoot.hostRef, commandId: expect.any(String) }])
  expect(writes[0]).toMatchObject({ hostRef: workerRoot.hostRef, relativePath: 'studio-project', expectedLocationRevision: 1, expectedRootPolicyRevision: 0 })
  expect(setups).toEqual([{ workspaceId: scope.workspaceId, commandId: expect.any(String), accessMode: 'exclusive-write',
    selection: { hostRef: workerRoot.hostRef, rootPolicyId: expect.any(String), rootPolicyRevision: '1', locationRevision: '1' } }])
  const ready = await screen.findByRole('option', { name: 'Studio · studio-project' })
  expect(reads).toBeGreaterThan(1)
  await user.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), ready)
  expect(screen.getByRole('combobox', { name: 'Computer' })).toHaveValue(ready.getAttribute('value'))
  expect(screen.queryByText(reason)).not.toBeInTheDocument()
})

it.each([true, false])('lets compact settings add a Worker folder and keep Main available (configuration adopted: %s)', async adopted => {
  if (!adopted) allowlists = [mainRoot]
  mount(true)
  const user = userEvent.setup()
  const computer = await screen.findByRole('combobox', { name: 'Computer and folder' })
  await waitFor(() => expect(within(computer).getByRole('option', { selected: true })).toHaveTextContent('Main computer'))
  await user.selectOptions(computer, within(computer).getByRole('option', { name: /Worker computer/ }))
  await waitFor(() => expect(screen.getByRole('combobox', { name: 'Computer and folder' })).toHaveDisplayValue(/Worker computer.*shared/))
  await user.click(screen.getByRole('button', { name: 'Execution location' }))
  const dialog = await screen.findByRole('dialog', { name: 'Execution folder' })
  await user.click(within(dialog).getByRole('button', { name: 'Browse' }))
  await user.click(await within(dialog).findByRole('button', { name: 'studio-project' }))
  await user.click(within(dialog).getByRole('button', { name: 'Use this folder' }))
  await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
  expect(writes).toHaveLength(1)
  expect(writes[0]).toMatchObject({ hostRef: workerRoot.hostRef, relativePath: 'studio-project', expectedLocationRevision: 1 })
  expect(adoptions).toEqual(adopted ? [] : [{ workspaceId: scope.workspaceId, hostRef: workerRoot.hostRef, commandId: expect.any(String) }])
  const computers = screen.getByRole('combobox', { name: 'Computer and folder' })
  await user.selectOptions(computers, within(computers).getByRole('option', { name: /Main computer/ }))
  expect(await screen.findByRole('button', { name: 'Execution location' })).toHaveAttribute('title', '/projects/shared/main-project')
})

it('keeps other unavailable reasons explanatory without offering project setup', async () => {
  reason = 'Studio is offline.'
  mount()
  await userEvent.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), await screen.findByRole('option', { name: 'Studio · unavailable' }))
  expect(screen.getByText(reason)).toBeVisible()
  expect(screen.queryByRole('button', { name: 'Set up on Studio' })).not.toBeInTheDocument()
})


it.each(['unpaired Worker', 'revised Main configuration'])('recovers compact settings after a selected root disappears: %s', async change => {
  const view = mount(true), user = userEvent.setup()
  const computer = await screen.findByRole('combobox', { name: 'Computer and folder' })
  await waitFor(() => expect(computer).toHaveDisplayValue(/Main computer/))
  if (change === 'unpaired Worker') {
    await user.selectOptions(computer, within(computer).getByRole('option', { name: /Worker computer/ }))
    await act(async () => { await clients.at(-1)!.invalidateQueries({ queryKey: boundLocationKeys.choices(scope.workspaceId) }) })
    expect(screen.getByRole('combobox', { name: 'Computer and folder' })).toHaveDisplayValue(/Worker computer/)
    allowlists = [mainRoot]
    server.use(http.get('/api/devices', () => HttpResponse.json({ devices: [] })))
  } else allowlists = [{ ...mainRoot, configurationRevision: '2' }, workerRoot]
  await act(async () => { await clients.at(-1)!.invalidateQueries() })
  await waitFor(() => expect(screen.getByRole('button', { name: 'Execution location' })).toHaveAttribute('title', '/projects/shared/main-project'))
  if (change === 'revised Main configuration') await waitFor(() => expect(screen.getByRole('combobox', { name: 'Computer and folder' })).toHaveDisplayValue(/Main computer/))
  expect(screen.queryByText('Reading Main folder settings…')).not.toBeInTheDocument()
  view.unmount()
  mount(true)
  expect(await screen.findByRole('button', { name: 'Execution location' })).toHaveAttribute('title', '/projects/shared/main-project')
  await user.click(screen.getByRole('button', { name: 'Execution location' }))
  const dialog = await screen.findByRole('dialog', { name: 'Choose folder' })
  expect(await within(dialog).findByRole('button', { name: 'studio-project' })).toBeVisible()
})


it('shows a failed computer configuration read and retries before offering that computer’s folders', async () => {
  allowlists = [mainRoot]
  server.use(http.post('/api/management/workspaces/workspace-1/root-configurations/adopt', async ({ request }) => {
    adoptions.push(await request.json())
    if (adoptions.length === 1) return HttpResponse.json({ error: { code: 'ROOT_CONFIGURATION_UNAVAILABLE', message: 'Studio did not respond.' } }, { status: 503 })
    allowlists = [mainRoot, workerRoot]
    return HttpResponse.json({ value: workerRoot, replayed: true })
  }))
  mount()
  const user = userEvent.setup()
  await user.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), await screen.findByRole('option', { name: 'Studio · unavailable' }))
  await user.click(screen.getByRole('button', { name: 'Set up on Studio' }))
  const dialog = await screen.findByRole('dialog', { name: 'Execution folder' })
  expect(await within(dialog).findByText('Studio did not respond.')).toBeVisible()
  expect(within(dialog).getByRole('button', { name: 'Use this folder' })).toBeDisabled()
  expect(within(dialog).queryByRole('textbox', { name: 'Subfolder' })).not.toBeInTheDocument()
  await user.click(within(dialog).getByRole('button', { name: 'Retry computer folders' }))
  await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Computer and folder' })).toHaveDisplayValue(/Worker computer/))
  expect(within(dialog).getByRole('textbox', { name: 'Subfolder' })).toBeVisible()
  expect(adoptions).toHaveLength(2)
  expect(adoptions[1]).toEqual(adoptions[0])
  expect(writes).toEqual([])
})

it('keeps setup open when project capture fails', async () => {
  server.use(http.post('/api/management/workspaces/workspace-1/source-roots/setup', async ({ request }) => {
    const input = await request.json() as SourceRootSetupInput
    if ('hostRef' in input) return HttpResponse.json({ value: { kind: 'selection-required' }, replayed: false })
    return HttpResponse.json({ error: { code: 'SOURCE_CAPTURE_FAILED', message: 'Project capture failed.' } }, { status: 503 })
  }))
  mount()
  const user = userEvent.setup()
  await user.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), await screen.findByRole('option', { name: 'Studio · unavailable' }))
  await user.click(screen.getByRole('button', { name: 'Set up on Studio' }))
  const dialog = await screen.findByRole('dialog', { name: 'Execution folder' })
  await waitFor(() => expect(within(dialog).getByRole('combobox', { name: 'Computer and folder' })).toHaveDisplayValue(/Worker computer/))
  await user.click(within(dialog).getByRole('button', { name: 'Use this folder' }))
  expect(await within(dialog).findByText('Project capture failed.')).toBeVisible()
  expect(screen.getByRole('option', { name: 'Studio · unavailable' })).toBeInTheDocument()
  expect(writes).toHaveLength(1)
})

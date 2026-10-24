import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import type { WorkspaceRootSelection } from '@foreman-code/contracts/workspace-root-policies'
import { server } from '../../mocks/server'
import { queryKeys } from '../../shared/api/query'
import { workerRoot, rootSetReadback } from '../settings/workspaceBoundLocation.fixtures'
import { useBoundLocationDraftStore } from '../settings/workspaceBoundLocationDraftStore'
import { usePlacementChoices } from './usePlacementChoices'
import { NodePlacementField } from './NodePlacementField'

it.each([true, false])('sets up a plain folder and refreshes the Computer picker (managed: %s)', async automatic => {
  const workspaceId = 'empty-workspace'
  const scope = { workspaceId, workflowId: 'workflow', nodeId: 'node', agentConfigurationVersionId: 'configuration' }
  let policy: ReturnType<typeof rootSetReadback> | undefined
  let ready = false
  let selected: SavedNodePlacement | undefined
  const writes: unknown[] = []
  const placement: SavedNodePlacement = { schemaVersion: 1, hostRef: workerRoot.hostRef,
    rootPolicyId: '66666666-6666-4666-8666-666666666666', rootPolicyRevision: '1', locationRevision: '1',
    projectRoot: '/projects/shared/empty-workspace', cwdPolicy: 'project-root', relativeCwd: '',
    instanceId: 'profile', instanceRevision: '1', harnessInstallationId: 'codex' }
  const managed = { workspace: { id: workspaceId, name: 'Empty' }, revision: 1,
    archivedAt: null, executionLocation: { runnerId: 'runner-local', rootPath: '/main/empty' }, locationRevision: 1,
    locationValidation: { status: 'ready', checkedAt: '2026-10-01T00:00:00Z' } }
  server.use(
    http.get(`*/api/management/workspaces/${workspaceId}`, () => HttpResponse.json(managed)),
    http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/nodes/:nodeId/placement-choices', () => HttpResponse.json({
      ...scope, pending: false, choices: ready ? [{ id: 'paired', label: 'Paired computer · codex', placement, availability: 'ready', reason: null }] : [],
      unavailableComputers: ready ? [] : [{ hostRef: workerRoot.hostRef, name: 'Paired computer', reason: 'This workspace’s project isn’t set up on Paired computer yet.' }],
    })),
    http.get(`*/api/management/workspaces/${workspaceId}/root-location`, () => HttpResponse.json({ evidence: 'legacy_missing', workspaceId,
      locationRevision: 1, executionLocation: { runnerId: 'runner-local', rootPath: '/main/empty' } })),
    http.get(`*/api/management/workspaces/${workspaceId}/root-policies`, () => HttpResponse.json({ workspaceId,
      readiness: 'metadata-only', policies: [], allowlists: [workerRoot] })),
    http.put(`*/api/management/workspaces/${workspaceId}/root-location`, async ({ request }) => {
      const input = await request.json() as WorkspaceRootSelection
      policy = rootSetReadback(input, workerRoot)
      writes.push(input)
      return HttpResponse.json({ value: policy, replayed: false })
    }),
    http.post(`*/api/management/workspaces/${workspaceId}/source-roots/setup`, async ({ request }) => {
      const input = await request.json() as { hostRef?: unknown }
      writes.push(input)
      if (input.hostRef) {
        if (!automatic) return HttpResponse.json({ value: { kind: 'selection-required' }, replayed: false })
        policy = rootSetReadback({ workspaceId, hostRef: workerRoot.hostRef, allowedBaseId: workerRoot.bases[0]!.baseId,
          configurationRevision: '1', relativePath: 'empty-workspace', accessMode: 'read-write',
          expectedLocationRevision: 1, expectedRootPolicyRevision: 0 }, workerRoot)
      }
      if (policy?.evidence !== 'bound') throw new Error('Folder must be saved before setup')
      ready = true
      return HttpResponse.json({ value: { kind: 'plain', policy: policy.binding }, replayed: false })
    }),
  )
  function Picker() {
    const choices = usePlacementChoices(scope, 'plain-setup')
    const [value, setValue] = useState<SavedNodePlacement>()
    return <NodePlacementField workspaceId={workspaceId} value={value} options={choices.options}
      unavailableComputers={choices.unavailableComputers} onChange={next => { selected = next; setValue(next) }} />
  }
  useBoundLocationDraftStore.getState().reset()
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  client.setQueryData(queryKeys.managedWorkspace(workspaceId), managed)
  const view = render(<QueryClientProvider client={client}><Picker /></QueryClientProvider>)
  try {
    const user = userEvent.setup()
    await screen.findByRole('option', { name: 'Paired computer · unavailable' })
    await user.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), 'computer:0')
    await user.click(screen.getByRole('button', { name: 'Set up on Paired computer' }))
    if (!automatic) {
      await user.type(await screen.findByRole('textbox', { name: 'Subfolder' }), 'empty-workspace')
      await user.click(screen.getByRole('button', { name: 'Use this folder' }))
    }
    await screen.findByRole('option', { name: 'Paired computer' })
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument())
    await user.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), '0')
    expect(selected).toEqual(placement)
    expect(selected).not.toHaveProperty('source')
    expect(writes).toHaveLength(automatic ? 1 : 3)
  } finally { view.unmount(); client.clear(); useBoundLocationDraftStore.getState().reset() }
})

import { render, screen, waitFor, within } from '@testing-library/react'
import { QueryClientProvider } from '@tanstack/react-query'
import { ReactFlowProvider } from '@xyflow/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { NextDraftEditor } from '../graph'
import { boundRootReadback, workerRoot } from '../settings/workspaceBoundLocation.fixtures'
import { installBoardTestLifecycle, mountMeasuredBoard, newBoardQueryClient, type InspectionFixture } from './eng05D.testSupport'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'

installBoardTestLifecycle()
let fixture: InspectionFixture
beforeEach(async () => {
  fixture = await inspectionBoardFixture('small-ux')
  server.use(...fixture.mock.handlers,
    http.get('*/api/browser/profiles', () => HttpResponse.json({ profiles: [], replicas: [], presentReplicas: [], pendingReplicas: [], nextCursor: null, revision: 0 })))
})
const href = () => `/workspaces/${fixture.mock.workspaceId}?workflowId=${fixture.after.workflowId}`

it.each(['workspace', 'standalone'])('opens the execution folder dialog from the changed Worker folder notice on the %s Board', async (presentation) => {
  const workspaceId = fixture.mock.workspaceId
  const saved = boundRootReadback({ workspaceId, hostRef: workerRoot.hostRef,
    allowedBaseId: workerRoot.bases[0]!.baseId, configurationRevision: '1', relativePath: 'foreman',
    accessMode: 'read-write', expectedLocationRevision: 0, expectedRootPolicyRevision: 0 }, workerRoot)
  server.use(
    http.get(`*/api/management/workspaces/${workspaceId}`, async ({ request }) => HttpResponse.json({
      ...await (await fixture.mock.dispatch(request))!.json(), executionLocation: saved.executionLocation,
      locationValidation: { status: 'unavailable', checkedAt: '2026-10-01T00:00:00.000Z',
        error: { code: 'ROOT_DIRECTORY_CHANGED', message: 'The saved folder changed. Select it again to save its new identity.' } },
    })),
    http.get(`*/api/management/workspaces/${workspaceId}/root-location`, () => HttpResponse.json(saved)),
    http.get(`*/api/management/workspaces/${workspaceId}/root-policies`, () => HttpResponse.json({
      workspaceId, readiness: 'metadata-only', policies: saved.evidence === 'bound' ? [saved.binding] : [], allowlists: [workerRoot],
    })),
  )
  if (presentation === 'workspace') await mountMeasuredBoard(href())
  else render(<QueryClientProvider client={newBoardQueryClient()}><ReactFlowProvider>
    <NextDraftEditor workspaceId={workspaceId} workflowId={fixture.after.workflowId} />
  </ReactFlowProvider></QueryClientProvider>)
  await userEvent.click(await screen.findByRole('button', { name: 'Review folder' }))
  const dialog = await screen.findByRole('dialog', { name: 'Execution folder' })
  expect(await within(dialog).findByRole('combobox', { name: 'Computer and folder' })).toBeEnabled()
  expect(screen.getByText("This workspace's folder changed. Choose it again to keep using it.")).toBeVisible()
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog', { name: 'Execution folder' })).not.toBeInTheDocument()
}, 15_000)

it('points a new Agent Computer hint at the Save button in its own settings panel', async () => {
  await mountMeasuredBoard(href())
  await userEvent.click(await screen.findByRole('button', { name: 'Add agent' }))
  await userEvent.click(screen.getByRole('menuitem', { name: 'Worker' }))
  const navigation = screen.getByRole('navigation', { name: 'Agents and connections' })
  await userEvent.click(within(navigation).getByRole('button', { name: /^Worker/ }))
  const panel = await screen.findByRole('complementary', { name: 'Workflow side panel' })
  expect(await within(panel).findByText('Save this Agent to choose another computer.')).toBeVisible()
  expect(within(panel).getByRole('button', { name: 'Save agent settings and workflow' })).toBeEnabled()
}, 15_000)

it.each([['chat', 'Chat'], ['settings', 'Settings'], ['information', 'Details']])(
  'opens an unselected Agent %s on the first action click', async (action, tab) => {
    const { router } = await mountMeasuredBoard(href())
    await userEvent.click(await screen.findByRole('button', { name: 'Add agent' }))
    await userEvent.click(screen.getByRole('menuitem', { name: 'Worker' }))
    const navigation = screen.getByRole('navigation', { name: 'Agents and connections' })
    const name = within(navigation).getByRole('button', { name: /^Worker/ }).textContent!
    const button = await screen.findByRole('button', { name: `Open ${name} ${action}` })
    const nodeId = button.closest('[data-id]')!.getAttribute('data-id')
    await userEvent.click(button)
    const panel = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    expect(within(panel).getByRole('button', { name: tab })).toHaveAttribute('aria-pressed', 'true')
    await waitFor(() => expect(router.state.location.search).toMatchObject({
      boardPanel: 'agent', boardNodeId: nodeId, boardAgentTab: tab === 'Details' ? 'details' : action,
    }))
    await waitFor(() => expect(router.state.isLoading).toBe(false))
    expect(screen.getByRole('complementary', { name: 'Workflow side panel' })).toBeVisible()
    expect(screen.queryByRole('alertdialog')).not.toBeInTheDocument()
  }, 15_000,
)

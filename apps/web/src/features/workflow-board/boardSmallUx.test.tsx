import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { beforeEach, expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { server } from '../../mocks/server'
import { boundRootReadback, workerRoot } from '../settings/workspaceBoundLocation.fixtures'
import { installBoardTestLifecycle, mountMeasuredBoard, type InspectionFixture } from './eng05D.testSupport'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'

installBoardTestLifecycle()
let fixture: InspectionFixture
beforeEach(async () => {
  fixture = await inspectionBoardFixture('small-ux')
  server.use(...fixture.mock.handlers)
})
const href = () => `/workspaces/${fixture.mock.workspaceId}?workflowId=${fixture.after.workflowId}`

it('opens the workspace execution folder dialog from the changed Worker folder notice', async () => {
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
  await mountMeasuredBoard(href())
  await userEvent.click(await screen.findByRole('button', { name: 'Review folder' }))
  const dialog = await screen.findByRole('dialog', { name: 'Execution folder' })
  expect(await within(dialog).findByRole('combobox', { name: 'Computer and folder' })).toBeEnabled()
  expect(screen.getByText("This workspace's folder changed. Choose it again to keep using it.")).toBeVisible()
  await userEvent.click(within(dialog).getByRole('button', { name: 'Cancel' }))
  expect(screen.queryByRole('dialog', { name: 'Execution folder' })).not.toBeInTheDocument()
})

it('points a new Agent Computer hint at the Save button in its own settings panel', async () => {
  await mountMeasuredBoard(href())
  await userEvent.click(await screen.findByRole('button', { name: 'Add agent' }))
  await userEvent.click(screen.getByRole('menuitem', { name: 'Worker' }))
  const navigation = screen.getByRole('navigation', { name: 'Agents and connections' })
  await userEvent.click(within(navigation).getByRole('button', { name: /^Worker/ }))
  const panel = await screen.findByRole('complementary', { name: 'Workflow side panel' })
  expect(await within(panel).findByText('Save this Agent to choose another computer.')).toBeVisible()
  expect(within(panel).getByRole('button', { name: 'Save agent settings and workflow' })).toBeEnabled()
})

it.each([['chat', 'Chat'], ['settings', 'Settings'], ['information', 'Details']])(
  'opens an unselected Agent %s on the first action click', async (action, tab) => {
    const { router } = await mountMeasuredBoard(href())
    const node = fixture.first
    await userEvent.click(await screen.findByRole('button', { name: `Open ${node.name} ${action}` }))
    const panel = await screen.findByRole('complementary', { name: 'Workflow side panel' })
    expect(within(panel).getByRole('tab', { name: tab })).toHaveAttribute('aria-selected', 'true')
    await waitFor(() => expect(router.state.location.search).toMatchObject({
      boardPanel: 'agent', boardNodeId: node.id, boardAgentTab: tab === 'Details' ? 'details' : action,
    }))
  },
)

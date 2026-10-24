import { act, within, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import type { ComputerSyncStatus, ComputerSyncUpdateInput } from '@foreman-code/contracts/computer-accounts'
import { server } from '../../mocks/server'
import { ComputerSyncPanel } from './ComputerSync'
import { computersFixture, mainTarget } from './computersTestFixture'

const status = (): ComputerSyncStatus => ({ target: mainTarget, installed: true, running: true, message: null,
  folders: [{ workspaceId: 'workspace', name: 'Website', participating: true, enabled: true, revision: 1,
    status: { workspaceId: 'workspace', path: '/projects/shared/workspace-id', state: 'idle', connected: true,
      conflicts: [], message: null } }] })
async function open() {
  return within(document.body)
}

it('shows status and persists off and on with readback revisions', async () => {
  let saved = status()
  const writes: ComputerSyncUpdateInput[] = []
  computersFixture(<ComputerSyncPanel target={mainTarget} />, [
    http.post('*/api/management/computers/sync/status', () => HttpResponse.json(saved)),
    http.post('*/api/management/computers/sync/update', async ({ request }) => {
      const input = await request.json() as ComputerSyncUpdateInput
      writes.push(input)
      saved = { ...saved, folders: [{ ...saved.folders[0]!, enabled: input.enabled, revision: (input.expectedRevision ?? saved.folders[0]!.revision) + 1 }] }
      return HttpResponse.json(saved)
    }),
  ])
  const dialog = await open()
  const toggle = await dialog.findByRole('switch', { name: 'Website' })
  expect(dialog.getByText('Connected · idle')).toHaveAttribute('title', '/projects/shared/workspace-id')
  await userEvent.click(toggle)
  await waitFor(() => expect(toggle).not.toBeChecked())
  await userEvent.click(toggle)
  await waitFor(() => expect(toggle).toBeChecked())
  expect(writes.map(write => [write.enabled, write.expectedRevision, write.target])).toEqual([
    [false, 1, mainTarget], [true, 2, mainTarget],
  ])
  expect(writes[0]!.commandId).not.toBe(writes[1]!.commandId)
})

it('retries an uncertain save with the same command', async () => {
  const writes: ComputerSyncUpdateInput[] = []
  let release!: () => void
  const held = new Promise<void>(resolve => { release = resolve })
  computersFixture(<ComputerSyncPanel target={mainTarget} />, [
    http.post('*/api/management/computers/sync/status', () => HttpResponse.json(status())),
    http.post('*/api/management/computers/sync/update', async ({ request }) => {
      writes.push(await request.json() as ComputerSyncUpdateInput)
      await held
      if (writes.length === 1) return HttpResponse.error()
      return HttpResponse.json({ ...status(), folders: [{ ...status().folders[0]!, enabled: false, revision: 2 }] })
    }),
  ])
  const dialog = await open()
  await userEvent.click(await dialog.findByRole('switch', { name: 'Website' }))
  await waitFor(() => expect(writes).toHaveLength(1))
  release()
  await userEvent.click(await dialog.findByRole('button', { name: 'Retry sync save' }))
  await waitFor(() => expect(dialog.getByRole('switch', { name: 'Website' })).not.toBeChecked())
  expect(writes[1]).toEqual(writes[0])
})

it('recovers from an unavailable computer without treating old state as current', async () => {
  computersFixture(<ComputerSyncPanel target={mainTarget} />, [
    http.post('*/api/management/computers/sync/status', () => HttpResponse.json({ error: {
      code: 'COMPUTER_OFFLINE', message: 'Computer is offline.',
    } }, { status: 409 })),
  ])
  const dialog = await open()
  expect(await dialog.findByText(/Sync status is unavailable/)).toBeVisible()
  expect(dialog.queryByRole('switch')).not.toBeInTheDocument()
  server.use(http.post('*/api/management/computers/sync/status', () => HttpResponse.json(status())))
  await userEvent.click(dialog.getByRole('button', { name: 'Retry' }))
  expect(await dialog.findByRole('switch', { name: 'Website' })).toBeChecked()
})

it('explains deferred participation, folder errors and conflicts', async () => {
  const value = status()
  value.folders[0]!.participating = false
  value.folders[0]!.status = { ...value.folders[0]!.status!, state: 'error', connected: false,
    conflicts: ['draft.sync-conflict-20261008.txt'], message: 'One file could not be synced.' }
  computersFixture(<ComputerSyncPanel target={mainTarget} />, [
    http.post('*/api/management/computers/sync/status', () => HttpResponse.json(value)),
  ])
  const dialog = await open()
  expect(await dialog.findByText(/Starts when an Agent/)).toBeVisible()
  expect(dialog.getByText('One file could not be synced.')).toBeVisible()
  expect(dialog.getByText('draft.sync-conflict-20261008.txt')).toBeVisible()
})

it('rejects a mismatched computer response instead of showing another installation status', async () => {
  computersFixture(<ComputerSyncPanel target={mainTarget} />, [
    http.post('*/api/management/computers/sync/status', () => HttpResponse.json({ ...status(), target: {
      ...mainTarget, applicationInstallationId: '22222222-2222-4222-8222-222222222222',
    } })),
  ])
  const dialog = await open()
  expect(await dialog.findByText(/Sync status is unavailable/)).toBeVisible()
  expect(dialog.queryByRole('switch')).not.toBeInTheDocument()
})

it('recovers a revision conflict by refreshing before making a different save', async () => {
  let value = status()
  const writes: ComputerSyncUpdateInput[] = []
  const fixture = computersFixture(<ComputerSyncPanel target={mainTarget} />, [
    http.post('*/api/management/computers/sync/status', () => HttpResponse.json(value)),
    http.post('*/api/management/computers/sync/update', async ({ request }) => {
      const input = await request.json() as ComputerSyncUpdateInput
      writes.push(input)
      if (writes.length === 1) {
        value = { ...value, folders: [{ ...value.folders[0]!, revision: 2 }] }
        return HttpResponse.json({ error: { code: 'REVISION_CONFLICT', message: 'Sync settings changed. Refresh before saving.' } }, { status: 409 })
      }
      value = { ...value, folders: [{ ...value.folders[0]!, revision: 3, enabled: false }] }
      return HttpResponse.json(value)
    }),
  ])
  const dialog = await open()
  await userEvent.click(await dialog.findByRole('switch', { name: 'Website' }))
  expect(await dialog.findByText('Sync settings changed. Refresh before saving.')).toBeVisible()
  expect(dialog.queryByRole('button', { name: 'Retry sync save' })).not.toBeInTheDocument()
  await act(async () => { await fixture.client.invalidateQueries({ queryKey: ['computer-sync'] }) })
  await waitFor(() => expect(dialog.getByRole('switch', { name: 'Website' })).toBeEnabled())
  await userEvent.click(dialog.getByRole('switch', { name: 'Website' }))
  await waitFor(() => expect(dialog.getByRole('switch', { name: 'Website' })).not.toBeChecked())
  expect(writes.map(input => input.expectedRevision)).toEqual([1, 2])
  expect(writes[0]!.commandId).not.toBe(writes[1]!.commandId)
})


it('unlocks a rejected sync change after a successful background read', async () => {
  const fixture = computersFixture(<ComputerSyncPanel target={mainTarget} />, [
    http.post('*/api/management/computers/sync/status', () => HttpResponse.json(status())),
    http.post('*/api/management/computers/sync/update', () => HttpResponse.json({
      error: { code: 'REVISION_CONFLICT', message: 'Sync settings changed.' },
    }, { status: 409 })),
  ])
  const dialog = await open()
  const toggle = await dialog.findByRole('switch', { name: 'Website' })
  await userEvent.click(toggle)
  await dialog.findByText('Sync settings changed.')
  expect(toggle).toBeDisabled()
  await act(async () => { await fixture.client.invalidateQueries({ queryKey: ['computer-sync'] }) })
  await waitFor(() => expect(toggle).toBeEnabled())
  expect(toggle).toBeChecked()
})

it('distinguishes disabled sync from a disconnected peer and rechecks the connection beside the workspace', async () => {
  let value = status()
  value.folders[0]!.enabled = false
  value.folders[0]!.status!.connected = false
  const fixture = computersFixture(<ComputerSyncPanel target={mainTarget} />, [
    http.post('*/api/management/computers/sync/status', () => HttpResponse.json(value)),
  ])
  const panel = await open()
  const folder = within(await panel.findByRole('region', { name: 'Shared files for Website' }))
  expect(await folder.findByText('Sync off')).toBeVisible()
  expect(folder.queryByText(/Disconnected/)).not.toBeInTheDocument()
  value = { ...value, folders: [{ ...value.folders[0]!, enabled: true }] }
  await act(async () => { await fixture.client.invalidateQueries({ queryKey: ['computer-sync'] }) })
  expect(await folder.findByText('Waiting for a sync peer. This computer can be online while file sync is disconnected.')).toBeVisible()
  value = status()
  await userEvent.click(folder.getByRole('button', { name: 'Recheck sync status' }))
  expect(await folder.findByText('Connected · idle')).toBeVisible()
  expect(folder.queryByText(/Waiting for a sync peer/)).not.toBeInTheDocument()
})

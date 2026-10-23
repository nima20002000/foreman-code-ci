import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { BrowserProfilesSettings, type BrowserProfilesPort } from '../features/browser-profiles'
import { browserFilesFake, browserPortFake, browserRead, deferred } from '../features/agent-browser/testFixtures'
import { BrowserRecovery } from './BrowserRecovery'
import { browserProfileClient } from './browserRecovery'
import { browserUiClient } from './browserClients'

it('shows one cleanup notice when a setup browser opened by a retired settings page cannot be confirmed closed', async () => {
  const setup = { ...browserRead().session, subject: undefined, setupForProfileId: 'profile' }
  const opening = deferred<typeof setup>()
  const unused = vi.fn(async () => { throw new Error('Unused fixture method') })
  const port: BrowserProfilesPort = {
    readCatalog: vi.fn(async () => ({ profiles: [{ id: 'profile', name: 'Work', sourceComputerId: 'main', distribution: 'shared' as const,
      revision: 1, publishedRevision: 0 }], replicas: [{ profileId: 'profile', computerId: 'main', desiredSnapshot: null, receivedSnapshot: null,
      appliedSnapshot: null, transfer: 'missing' as const, loginEvidence: [], localOverride: false, lastSeenAt: '2026-10-20T00:00:00.000Z', reason: null }],
    presentReplicas: [{ profileId: 'profile', computerId: 'main' }], pendingReplicas: [] })),
    create: unused, addExisting: unused, update: unused, setLocalOverride: unused, confirmLogin: unused, remove: unused, sync: unused, readSync: unused,
    openSetup: vi.fn(() => opening.promise), closeSetup: browserProfileClient.closeSetup,
  }
  const close = vi.spyOn(browserUiClient, 'closeSession').mockResolvedValue('pending')
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  const page = (visible: boolean) => <QueryClientProvider client={client}>
    <BrowserProfilesSettings visible={visible} authBoundary="login" currentComputerId="main"
      computers={[{ id: 'main', name: 'Main', online: true, runtimeReady: true, lastSeenAt: null }]}
      port={port} sessionPort={browserPortFake().port} files={browserFilesFake()}
      onOpenSetup={vi.fn()} />
    <BrowserRecovery /></QueryClientProvider>
  const view = render(page(true))
  const main = within(await screen.findByRole('region', { name: 'Browser profiles on Main' }))
  await userEvent.click(main.getByRole('button', { name: 'Open browser' }))
  view.rerender(page(false)); opening.resolve(setup)
  await waitFor(() => expect(close).toHaveBeenCalledTimes(1))
  await screen.findAllByRole('button', { name: 'Retry browser cleanup' })
  await new Promise(settle => setTimeout(settle, 20))
  expect(screen.getAllByRole('button', { name: 'Retry browser cleanup' })).toHaveLength(1)
})

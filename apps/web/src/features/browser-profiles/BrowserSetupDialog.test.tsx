import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { act, render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { BrowserSetupDialog } from './BrowserSetupDialog'
import type { BrowserProfilesPort } from './types'
import { browserFilesFake, browserPortFake, browserRead, frame } from '../agent-browser/testFixtures'
import type { BrowserSessionRead } from '../agent-browser/types'

function setupRead(tabIds: string[], selectedTabId: string): BrowserSessionRead {
  const base = browserRead('setup-session')
  return { ...base, session: { ...base.session, subject: undefined, setupForProfileId: 'profile', selectedTabId },
    tabs: tabIds.map(tabId => ({ id: `lease-${tabId}`, sessionId: 'setup-session', tabId, browserGeneration: 1,
      title: `Page ${tabId}`, url: `https://fixture.test/${tabId}` })) }
}

it('falls back to the session tab when the selected setup tab is closed', async () => {
  const both = setupRead(['a', 'b'], 'a'), fake = browserPortFake(both)
  vi.mocked(fake.port.selectTab).mockImplementation(async () => { const next = setupRead(['a', 'b'], 'b'); fake.setRead(next); return next })
  vi.mocked(fake.port.closeTab).mockImplementation(async () => { const next = setupRead(['a'], 'a'); fake.setRead(next); return next })
  const client = new QueryClient({ defaultOptions: { queries: { retry: false }, mutations: { retry: false } } })
  render(<QueryClientProvider client={client}><BrowserSetupDialog authBoundary="login" session={both.session}
    profileName="Work" computerName="Main" port={fake.port} files={browserFilesFake()}
    profiles={{} as BrowserProfilesPort} onClosed={vi.fn()} onCleanupError={vi.fn()} /></QueryClientProvider>)
  const user = userEvent.setup()
  await waitFor(() => expect(fake.port.openView).toHaveBeenCalledTimes(1))
  act(() => fake.observer!.frame(frame('setup-session', 'a')))
  await user.click(await screen.findByRole('tab', { name: 'Page b' }))
  expect(await screen.findByRole('tab', { name: 'Page b', selected: true })).toBeTruthy()
  await waitFor(() => expect(fake.port.openView).toHaveBeenCalledTimes(2))
  act(() => fake.observer!.frame(frame('setup-session', 'b')))
  await user.click(screen.getByRole('button', { name: 'Close Page b' }))
  expect(await screen.findByRole('tab', { name: 'Page a', selected: true })).toBeTruthy()
  expect(screen.queryByText('No browser tab is open.')).toBeNull()
})

import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { accountTargetInfo } from '../provider-accounts/providerAccounts.fixtures'
import { computersFixture, mainId, mainTarget, mainConnections } from '../computers/computersTestFixture'
import { ComputerDetailSettings } from './ComputerDetailSettings'

it('retains default sign-ins while explaining that the empty account list is for additional accounts', async () => {
  const discovery = accountTargetInfo(mainTarget)
  discovery.providers = discovery.providers.map(provider => ({ ...provider, qualified: false, actions: [], reason: 'Isolation unavailable.' }))
  computersFixture(<ComputerDetailSettings mainId={mainId} devices={[]} />, [
    http.get('*/api/provider-accounts/targets', () => HttpResponse.json({ targets: [discovery] })),
    http.get('*/api/provider-accounts/page', () => HttpResponse.json({ target: mainTarget, revision: 1,
      accounts: [], defaults: [], nextCursor: null })),
    http.post('*/api/management/computers/maintenance/read', () => HttpResponse.json({ computers: [{ target: mainTarget,
      status: null, connections: { ...mainConnections, accounts: { ...mainConnections.accounts!,
        accounts: mainConnections.accounts!.accounts.map(account => ({ ...account, signedIn: true })) } },
    }] })),
  ])
  await userEvent.click(await screen.findByRole('tab', { name: 'Sign-ins' }))
  const defaults = within(await screen.findByRole('region', { name: 'Default sign-ins' }))
  expect(await defaults.findByRole('img', { name: 'Codex: signed in' })).toBeVisible()
  expect(defaults.getByRole('img', { name: 'Claude: signed in' })).toBeVisible()
  expect(screen.getByRole('heading', { name: 'Additional accounts About Accounts' })).toBeVisible()
  expect(await screen.findAllByText('No additional accounts added.')).toHaveLength(2)
  expect(screen.getAllByText("Separate accounts aren't available on this computer yet.")).toHaveLength(2)
})

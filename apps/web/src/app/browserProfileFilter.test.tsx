import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { BrowserProfileManager } from './BrowserProfileFeatures'
import { computersFixture, deviceTarget, mainId, registration } from '../features/computers/computersTestFixture'

it('keeps source identity and options when the profile manager is filtered to another computer', async () => {
  computersFixture(<BrowserProfileManager computer={deviceTarget} />, [
    http.get('*/api/devices/main', () => HttpResponse.json({ mainId, mainPublicKey: 'main-key', mainPublicKeyFingerprint: 'a'.repeat(64) })),
    http.get('*/api/devices', () => HttpResponse.json({ devices: [registration] })),
    http.get('*/api/browser/profiles', () => HttpResponse.json({ revision: 1, nextCursor: null,
      profiles: [{ id: 'profile', name: 'Work', sourceComputerId: mainId, distribution: 'shared', revision: 1, publishedRevision: 0 }],
      replicas: [], presentReplicas: [], pendingReplicas: [] })),
  ])
  expect(await screen.findByText('From Main PC')).toBeVisible()
  expect(screen.queryByRole('region', { name: 'Browser profiles on Main PC' })).not.toBeInTheDocument()
  await userEvent.click(screen.getByRole('button', { name: 'Edit profile' }))
  const source = screen.getByRole('combobox', { name: 'Source computer' })
  expect(source).toHaveValue(mainId)
  expect(within(source).getByRole('option', { name: 'Main PC' })).toBeEnabled()
  expect(within(source).queryByRole('option', { name: 'Computer unavailable' })).not.toBeInTheDocument()
})

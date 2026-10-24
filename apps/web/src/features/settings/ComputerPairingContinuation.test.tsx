import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { computersFixture, mainId, registration } from '../computers/computersTestFixture'
import { ComputerSettings } from './ComputerSettings'

it('continues lost-code pairing on the same computer using current revocation and enrollment services', async () => {
  let current = { ...registration, status: 'pending' as typeof registration.status }
  const revocations: unknown[] = []
  computersFixture(<ComputerSettings deviceId={registration.deviceId} />, [
    http.get('*/api/devices/main', () => HttpResponse.json({ mainId, mainPublicKey: 'main-key', mainPublicKeyFingerprint: 'b'.repeat(64) })),
    http.get('*/api/devices', () => HttpResponse.json({ devices: [current] })),
    http.get('*/api/devices/setup-options', () => HttpResponse.json({ available: true, endpoint: 'wss://192.168.1.10:8443/device/connect', reason: null })),
    http.post('*/api/devices/revoke', async ({ request }) => {
      revocations.push(await request.json())
      current = { ...current, status: 'revoked', authorizationRevision: 2 }
      return HttpResponse.json(current)
    }),
  ])
  const user = userEvent.setup()
  await user.click(await screen.findByRole('tab', { name: 'Connection' }))
  await user.click(await screen.findByRole('button', { name: 'Start pairing again' }))
  await user.click(screen.getByRole('button', { name: 'Revoke worker access' }))
  await waitFor(() => expect(revocations).toHaveLength(1))
  expect(revocations[0]).toMatchObject({ expectedRevision: 1 })
  expect(await screen.findByRole('textbox', { name: 'Computer request code' })).toBeVisible()
})

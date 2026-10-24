import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { encodeWorkerIdentityRequest } from '@foreman-code/contracts/device-setup'
import { computersFixture, mainId, registration } from '../computers/computersTestFixture'
import { ComputerSettings } from './ComputerSettings'

it('continues lost-code pairing on the same computer using current revocation and enrollment services', async () => {
  let current = { ...registration, status: 'pending' as typeof registration.status }
  const revocations: unknown[] = []
  const enrollments: unknown[] = []
  computersFixture(<ComputerSettings deviceId={registration.deviceId} />, [
    http.get('*/api/devices/main', () => HttpResponse.json({ mainId, mainPublicKey: 'main-key', mainPublicKeyFingerprint: 'b'.repeat(64) })),
    http.get('*/api/devices', () => HttpResponse.json({ devices: [current] })),
    http.get('*/api/devices/setup-options', () => HttpResponse.json({ available: true, endpoint: 'wss://192.168.1.10:8443/device/connect', reason: null })),
    http.post('*/api/devices/revoke', async ({ request }) => {
      revocations.push(await request.json())
      current = { ...current, status: 'revoked', authorizationRevision: 2 }
      return HttpResponse.json(current)
    }),
    http.post('*/api/devices/setup-codes', async ({ request }) => {
      enrollments.push(await request.json())
      current = { ...current, status: 'pending', authorizationRevision: 3 }
      return HttpResponse.json({ registration: current, enrollmentCode: 'GQLWE1.recovery-secret',
        expiresAt: new Date(Date.now() + 60_000).toISOString() })
    }),
  ])
  const user = userEvent.setup()
  await user.click(await screen.findByRole('tab', { name: 'Connection' }))
  await user.click(await screen.findByRole('button', { name: 'Start pairing again' }))
  await user.click(screen.getByRole('button', { name: 'Revoke worker access' }))
  await waitFor(() => expect(revocations).toHaveLength(1))
  expect(revocations[0]).toMatchObject({ expectedRevision: 1 })
  expect(await screen.findByRole('textbox', { name: 'Computer request code' })).toBeVisible()
  const requestCode = encodeWorkerIdentityRequest({ version: 1, kind: 'identity-request',
    workerInstallationId: registration.workerInstallationId, publicKey: 'public-key',
    publicKeyFingerprint: registration.publicKeyFingerprint })
  await user.click(screen.getByRole('textbox', { name: 'Computer request code' }))
  await user.paste(requestCode)
  await waitFor(() => expect(screen.getByRole('button', { name: 'Approve this computer' })).toBeEnabled())
  await user.click(screen.getByRole('button', { name: 'Approve this computer' }))
  await waitFor(() => expect(screen.getByRole('button', { name: 'Revoke worker access' })).toBeEnabled())
  expect(await screen.findByLabelText('Private pairing code · secret')).toHaveValue('GQLWE1.recovery-secret')
  await user.click(screen.getByRole('button', { name: 'Copy pairing code' }))
  expect(await navigator.clipboard.readText()).toBe('GQLWE1.recovery-secret')
  expect(await screen.findByText('Copied. Paste it into the companion.')).toBeVisible()
  expect(enrollments).toEqual([expect.objectContaining({ identityRequestCode: requestCode, expectedAuthorizationRevision: 2 })])
  await user.click(screen.getByRole('button', { name: 'Discard pairing code' }))
  expect(screen.queryByLabelText('Private pairing code · secret')).not.toBeInTheDocument()
  expect(screen.getByRole('button', { name: 'Start pairing again' })).toBeVisible()
})

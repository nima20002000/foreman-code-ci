import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { server } from '../../mocks/server'
import { registration } from '../computers/computersTestFixture'
import { useOperatorChatStore } from '../operator-chat'
import { ConnectionSetupStatus } from './DeviceSetupGuide'

it('reads trusted connection readiness separately from pairing and refreshes it with the selected identity', async () => {
  let ready = true
  const checks: unknown[] = []
  server.use(http.post('*/api/devices/connection-check', async ({ request }) => {
    checks.push(await request.json())
    return HttpResponse.json({ registration, consent: null, state: ready ? 'ready' : 'offline', probe: null,
      checkedAt: '2026-10-24T00:00:00.000Z' })
  }))
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><ConnectionSetupStatus registration={registration} /></QueryClientProvider>)
  const user = userEvent.setup()
  expect(await screen.findByText('Connection ready.')).toBeVisible()
  ready = false
  await user.click(screen.getByRole('button', { name: 'Check connection' }))
  expect(await screen.findByText('Connection offline.')).toBeVisible()
  await user.click(screen.getByRole('button', { name: 'Ask Operator' }))
  expect(useOperatorChatStore.getState().request?.content).toContain(registration.deviceId)
  await waitFor(() => expect(checks).toHaveLength(2))
  expect(checks[0]).toEqual({ deviceId: registration.deviceId })
  view.unmount(); client.clear(); useOperatorChatStore.getState().reset()
})

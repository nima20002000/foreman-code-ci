import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { useOperatorChatStore } from '../operator-chat'
import { expect, it } from 'vitest'
import { ComputerCards } from './ComputerCards'
import { computersFixture, deviceName, mainId, registration } from './computersTestFixture'

it('shows the host-scoped Foreman MCP state read-only on a paired computer, from the maintenance readback', async () => {
  const { activity } = computersFixture(<ComputerCards mainId={mainId} devices={[registration]} />)
  // An Offline computer reports nothing live, so its tool chips are hidden.
  activity.computers[1]!.online = true
  const device = await screen.findByRole('article', { name: deviceName })
  // The fixture reports Codex installed and Claude missing for the paired computer.
  expect(await within(device).findByRole('img', { name: 'Foreman MCP: Claude not set up' })).toHaveAttribute('data-state', 'missing')
  expect(within(device).queryByRole('button', { name: /install.*mcp|repair.*mcp/i })).not.toBeInTheDocument()
  expect(within(device).getByRole('button', { name: 'Ask Operator to change…' })).toBeVisible()
})


it('keeps a scoped MCP repair handoff when the same computer is opened in detail', async () => {
  const { activity } = computersFixture(<ComputerCards mainId={mainId} devices={[registration]} only={registration.deviceId} />)
  activity.computers[1]!.online = true
  const card = await screen.findByRole('article', { name: deviceName })
  expect(await within(card).findByRole('img', { name: 'Foreman MCP: Claude not set up' })).toBeVisible()
  await userEvent.click(within(card).getByRole('button', { name: 'Ask Operator to change…' }))
  expect(useOperatorChatStore.getState().request?.content).toContain(deviceName)
})

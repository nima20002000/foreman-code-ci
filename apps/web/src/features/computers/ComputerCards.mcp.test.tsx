import { screen, within } from '@testing-library/react'
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

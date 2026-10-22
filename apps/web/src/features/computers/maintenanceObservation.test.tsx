import { act, screen, within } from '@testing-library/react'
import { afterEach, expect, it, vi } from 'vitest'
import { ComputerCards } from './ComputerCards'
import { computerReadHandler, computersFixture, mainId, mainTarget } from './computersTestFixture'

afterEach(() => vi.useRealTimers())

it('shows a lasting maintenance observation failure on the computer card with a retry', async () => {
  vi.useFakeTimers({ shouldAdvanceTime: true })
  computersFixture(<ComputerCards mainId={mainId} devices={[]} />, [
    computerReadHandler('maintenance', { computers: [{ target: mainTarget, status: null, observation: {
      status: 'unavailable', lastError: 'Maintenance observation failed (DEVICE_TRANSPORT_ERROR).',
      failedAt: '2026-10-14T00:00:01Z', lastSuccess: null, consecutiveFailures: 2,
    } }] }),
  ])
  const card = await screen.findByRole('article', { name: 'Main PC' })
  await act(async () => { await vi.advanceTimersByTimeAsync(20_000) })
  expect(await within(card).findByRole('alert')).toHaveTextContent('Status may be out of date.')
  expect(within(card).getByRole('button', { name: 'Retry' })).toBeVisible()
})

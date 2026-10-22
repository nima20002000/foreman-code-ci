import { screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { afterEach, expect, it } from 'vitest'
import { cleanup } from '@testing-library/react'
import { computersFixture, mainTarget } from '../computers/computersTestFixture'
import { ComputerBuildSettings } from './ComputerDetailSettings'

afterEach(cleanup)

it('saves one computer\'s build settings with the revision it read, then shows the saved values', async () => {
  const updates: Array<Record<string, unknown>> = []
  const { statuses } = computersFixture(<ComputerBuildSettings target={mainTarget} />, [
    http.post('*/api/management/settings/build-computers/update', async ({ request }) => {
      const body = await request.json() as Record<string, unknown>
      updates.push(body)
      const key = [...statuses.keys()].find(value => value.includes('main'))!
      const current = statuses.get(key)!
      const next = { ...current, preference: { ...current.preference, revision: 2, buildPriority: body.buildPriority as number } }
      statuses.set(key, next)
      return HttpResponse.json(next)
    }),
  ])
  const user = userEvent.setup()
  const priority = await screen.findByRole('spinbutton', { name: 'Priority' })
  expect(priority).toHaveValue(100)
  expect(screen.getByRole('spinbutton', { name: 'Allowance (%)' })).toHaveValue(60)
  expect(screen.getByRole('button', { name: 'Save build settings' })).toBeDisabled()
  await user.clear(priority)
  await user.type(priority, '40')
  await user.click(screen.getByRole('button', { name: 'Save build settings' }))
  await waitFor(() => expect(updates).toHaveLength(1))
  expect(updates[0]).toMatchObject({ expectedRevision: 1, buildEnabled: true, buildPriority: 40, buildAllowancePercent: 60 })
  expect(await screen.findByText('Saved.')).toBeVisible()
  await waitFor(() => expect(screen.getByRole('spinbutton', { name: 'Priority' })).toHaveValue(40))
})

it('keeps edits and reports a rejected stale save instead of overwriting newer settings', async () => {
  computersFixture(<ComputerBuildSettings target={mainTarget} />, [
    http.post('*/api/management/settings/build-computers/update', () => HttpResponse.json(
      { error: { code: 'REVISION_CONFLICT', message: 'These build settings changed. Reload them.' } }, { status: 409 })),
  ])
  const user = userEvent.setup()
  const priority = await screen.findByRole('spinbutton', { name: 'Priority' })
  await user.clear(priority)
  await user.type(priority, '7')
  await user.click(screen.getByRole('button', { name: 'Save build settings' }))
  expect(await screen.findByText('Couldn’t save build settings')).toBeVisible()
  expect(screen.getByRole('spinbutton', { name: 'Priority' })).toHaveValue(7)
})

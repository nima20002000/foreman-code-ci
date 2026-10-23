import { screen } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { expect, it } from 'vitest'
import { AppearanceSettings } from './AppearanceSettings'
import { computersFixture } from '../computers/computersTestFixture'

it('shows the saved theme as the selected one', async () => {
  computersFixture(<AppearanceSettings />, [
    http.get('*/api/management/settings/general', () => HttpResponse.json({
      value: { theme: 'light' }, revision: 1, versionId: 'general-1',
    })),
  ])
  expect(await screen.findByRole('radio', { name: 'Light' })).toBeChecked()
  expect(screen.getByRole('radio', { name: 'Dark' })).not.toBeChecked()
})

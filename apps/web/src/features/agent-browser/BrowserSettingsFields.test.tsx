import { useState } from 'react'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import type { NodeBrowserSettings } from './types'
import { BrowserSettingsFields } from './BrowserSettingsFields'

afterEach(cleanup)

it('retains the saved tab limit when the browser is turned off and back on', async () => {
  function Settings() {
    const [browser, setBrowser] = useState<NodeBrowserSettings>({ enabled: true, profileId: 'work', maxTabs: 7 })
    return <BrowserSettingsFields value={browser} onChange={setBrowser} catalog={undefined}
      computer={undefined} onManageProfiles={() => undefined} />
  }
  render(<Settings />)
  const user = userEvent.setup()
  expect(screen.getByRole('combobox', { name: 'Most tabs open at once' })).toHaveValue('7')
  await user.click(screen.getByRole('switch', { name: 'Browser' }))
  expect(screen.queryByRole('combobox', { name: 'Most tabs open at once' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('switch', { name: 'Browser' }))
  expect(screen.getByRole('combobox', { name: 'Browser profile' })).toHaveValue('work')
  expect(screen.getByRole('combobox', { name: 'Most tabs open at once' })).toHaveValue('7')
})

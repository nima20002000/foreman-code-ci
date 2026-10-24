import { screen, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { computersFixture, mainId } from '../computers/computersTestFixture'
import { UnsavedChangesProvider } from '../../shared/ui/UnsavedChangesProvider'
import { ComputerDetailSettings } from './ComputerDetailSettings'

it.each(['Computer name', 'Priority', 'Allowance (%)'])('guards an unsaved %s when changing computer tabs', async label => {
  computersFixture(<UnsavedChangesProvider><ComputerDetailSettings mainId={mainId} devices={[]} /></UnsavedChangesProvider>)
  const user = userEvent.setup()
  const input = await screen.findByRole(label === 'Computer name' ? 'textbox' : 'spinbutton', { name: label })
  await user.clear(input)
  await user.type(input, label === 'Computer name' ? 'My computer' : '40')
  await user.click(screen.getByRole('tab', { name: 'Sign-ins' }))
  const guard = await screen.findByRole('alertdialog', { name: 'Save changes before leaving?' })
  await user.click(within(guard).getByRole('button', { name: 'Close dialog' }))
  expect(input).toHaveValue(label === 'Computer name' ? 'My computer' : 40)
  expect(screen.getByRole('tab', { name: 'Overview' })).toHaveAttribute('aria-selected', 'true')
  await user.click(screen.getByRole('tab', { name: 'Files and browsers' }))
  await user.click(within(await screen.findByRole('alertdialog')).getByRole('button', { name: 'Discard' }))
  expect(await screen.findByRole('tabpanel', { name: 'Files and browsers' })).toBeVisible()
})

import { screen, within } from '@testing-library/react'
import { expect, it } from 'vitest'
import { computersFixture, mainId } from '../computers/computersTestFixture'
import { ComputerDetailSettings } from './ComputerDetailSettings'

it('uses one explicit name editor in computer detail while the maintenance heading stays read-only', async () => {
  computersFixture(<ComputerDetailSettings mainId={mainId} devices={[]} />)
  expect(await screen.findByRole('textbox', { name: 'Computer name' })).toHaveValue('Main PC')
  expect(screen.getByRole('button', { name: 'Save name' })).toBeDisabled()
  expect(within(screen.getByRole('article', { name: 'Main PC' })).queryByRole('button', { name: 'Main PC' })).not.toBeInTheDocument()
})

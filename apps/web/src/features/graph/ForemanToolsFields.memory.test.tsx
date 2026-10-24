import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { effectiveForemanTools, memoryBoardTools, type ForemanAgentTool, type ForemanToolOverride } from '@foreman-code/contracts'
import { ForemanToolsFields } from './ForemanToolsFields'

it('changes grouped memory access without changing other node tools or agent defaults', async () => {
  const user = userEvent.setup()
  function Settings() {
    const [defaults, setDefaults] = useState<ForemanAgentTool[] | undefined>(['context_get'])
    const [override, setOverride] = useState<ForemanToolOverride | undefined>({ add: ['interaction_get'], remove: [] })
    return <>
      <ForemanToolsFields role="coder" defaults={defaults} override={override} onChange={(next, change) => {
        setDefaults(next)
        setOverride(change)
      }} />
      <output aria-label="Effective tools">{effectiveForemanTools('coder', defaults, override, false, memoryBoardTools('write')).join(',')}</output>
      <output aria-label="Agent defaults">{defaults?.join(',')}</output>
    </>
  }
  render(<Settings />)
  await user.selectOptions(screen.getByRole('combobox', { name: 'Memory access' }), 'write')
  expect(screen.getByLabelText('Effective tools')).toHaveTextContent('memory_card_create')
  expect(screen.getByLabelText('Effective tools')).toHaveTextContent('interaction_get')
  expect(screen.getByLabelText('Agent defaults')).toHaveTextContent(/^context_get$/)
  await user.selectOptions(screen.getByRole('combobox', { name: 'Memory access' }), 'read')
  expect(screen.getByLabelText('Effective tools')).toHaveTextContent('memory_board_get')
  expect(screen.getByLabelText('Effective tools')).not.toHaveTextContent('memory_card_create')
  await user.selectOptions(screen.getByRole('combobox', { name: 'Memory access' }), 'none')
  expect(screen.getByLabelText('Effective tools')).not.toHaveTextContent('memory_')
  expect(screen.getByLabelText('Effective tools')).toHaveTextContent('interaction_get')
})

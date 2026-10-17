import { screen, waitFor, within } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { installBoardTestLifecycle, measureBoardWire, mountMeasuredBoard } from './eng05D.testSupport'
import { meaningfulSaveFixture } from './meaningfulSave.testSupport'

installBoardTestLifecycle()

it('keeps workflow settings labels and values visible and puts explanations in hints', async () => {
  const fixture = await meaningfulSaveFixture()
  measureBoardWire(fixture.mock, fixture.reply)
  await mountMeasuredBoard(fixture.href)
  const user = userEvent.setup()
  await user.click(await screen.findByRole('button', { name: 'Workflow settings' }))
  const settings = within(screen.getByRole('complementary', { name: 'Workflow settings' }))
  expect(settings.getByRole('combobox', { name: 'Starts the workflow' })).toHaveValue('node-0')
  expect(settings.getByRole('combobox', { name: 'Approval handler' })).toHaveValue('user')
  expect(settings.getByRole('spinbutton', { name: 'Maximum parallelism' })).toHaveValue(4)
  expect(settings.getByRole('spinbutton', { name: 'Maximum node executions' })).toHaveValue(1000)
  expect(settings.getByText(/Based on saved version/)).toBeVisible()

  const explanations = [
    ['Starts the workflow', 'The first node to run. It can’t receive a dependency.'],
    ['Approval handler', 'Agents ask you before sensitive actions. Requests appear in the approval inbox.'],
    ['Maximum parallelism', 'Agents running at once'],
    ['Maximum node executions', 'Agent turns per run'],
    ['Agent active-time budget (seconds)', /Per Agent execution; approval waits are excluded/],
    ['Execution folder', 'Runs work in this workspace’s folder.'],
  ] as const
  for (const [label, explanation] of explanations) {
    expect(settings.queryByText(explanation)).not.toBeInTheDocument()
    const hint = settings.getByRole('button', { name: `About ${label}` })
    await user.hover(hint)
    expect(screen.getByRole('tooltip')).toHaveTextContent(explanation)
    expect(hint).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id)
    await user.unhover(hint)
    await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
  }
})

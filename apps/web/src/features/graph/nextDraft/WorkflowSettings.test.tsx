import { render, screen, waitFor } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it, vi } from 'vitest'
import { fixture } from './core.cases'
import { newNextDraft } from './state'
import { WorkflowSettings } from './WorkflowSettings'

const explanations = [
  ['Starts with', 'The first node to run. It can’t receive a dependency.'],
  ['Who approves', 'Agents ask you before sensitive actions. Requests appear in the approval inbox.'],
  ['Turn time limit', /Seconds per agent turn\. Leave blank for the default \(600 s\)/],
] as const

it.each(explanations)('keeps settings visible and shows the %s explanation on hover', async (label, explanation) => {
  render(<WorkflowSettings draftKey="settings-test" edit={newNextDraft(fixture(), 'settings-test')} change={vi.fn()} report={vi.fn()}
    defaultMs={600_000} locationReady locationMessage="" onChangeFolder={vi.fn()} onReload={vi.fn()} />)
  const user = userEvent.setup()
  const settings = screen
  expect(settings.getByRole('combobox', { name: 'Starts with' })).toHaveValue('node-0')
  expect(settings.getByRole('combobox', { name: 'Who approves' })).toHaveValue('user')
  expect(settings.getByRole('spinbutton', { name: 'Agents at once' })).toHaveValue(4)
  expect(settings.getByRole('spinbutton', { name: 'Agent turns per run' })).toHaveValue(1000)
  expect(settings.getByText('Workspace folder')).toBeVisible()

  expect(settings.queryByText(explanation)).not.toBeInTheDocument()
  const hint = settings.getByRole('button', { name: `About ${label}` })
  await user.hover(hint)
  expect(screen.getByRole('tooltip')).toHaveTextContent(explanation)
  expect(hint).toHaveAttribute('aria-describedby', screen.getByRole('tooltip').id)
  await user.unhover(hint)
  await waitFor(() => expect(screen.queryByRole('tooltip')).not.toBeInTheDocument())
})

it('opens the latest saved version from the Saved version section', async () => {
  const reload = vi.fn()
  render(<WorkflowSettings draftKey="settings-test" edit={newNextDraft(fixture(), 'settings-test')} change={vi.fn()} report={vi.fn()}
    defaultMs={600_000} locationReady locationMessage="" onChangeFolder={vi.fn()} onReload={reload} />)
  await userEvent.setup().click(screen.getByRole('button', { name: 'Reload' }))
  expect(reload).toHaveBeenCalledOnce()
})

it('keeps required actions, unsaved state, and configured values visible beside optional guidance', async () => {
  const context = fixture()
  context.draft.baseWorkflowVersionId = null
  const edit = newNextDraft(context, 'settings-test')
  edit.graph = { ...edit.graph, entryNodeId: 'removed-node', requiredAgentCount: 2,
    handoffs: { contractVersion: 1 } }
  const changeFolder = vi.fn()
  render(<WorkflowSettings draftKey="settings-test" edit={edit} change={vi.fn()} report={vi.fn()} defaultMs={undefined}
    locationReady={false} locationMessage="Choose an execution folder to run this workflow."
    onChangeFolder={changeFolder} onReload={vi.fn()} />)
  expect(screen.getByRole('alert')).toHaveTextContent('The starting node was removed. Choose another one.')
  expect(screen.getByText('Choose an execution folder to run this workflow.')).toBeVisible()
  expect(screen.queryByRole('region', { name: 'Saved version' })).not.toBeInTheDocument()
  expect(screen.getByRole('spinbutton', { name: 'Required agents' })).toHaveValue(2)
  expect(screen.queryByText(/Set each work connection’s Run-wide handoff limit/)).not.toBeInTheDocument()
  const user = userEvent.setup()
  await user.hover(screen.getByRole('button', { name: 'About Limits' }))
  expect(screen.getByRole('tooltip')).toHaveTextContent('Set each work connection’s handoff limit on its line on the Board.')
  await user.click(screen.getByRole('button', { name: 'Choose folder' }))
  expect(changeFolder).toHaveBeenCalledOnce()
})

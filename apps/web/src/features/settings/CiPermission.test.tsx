import { useState } from 'react'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { HarnessSectionFields } from './HarnessSectionFields'
import { createHarnessEditor } from './harnessEditor'

function AgentPermissions() {
  const [editor, setEditor] = useState(() => createHarnessEditor(DEFAULT_HARNESS_DEFAULTS.codex))
  return <HarnessSectionFields editor={editor} onChange={setEditor} section="permissions" allowCiFullScope />
}

it('lets an owner explicitly enable and revoke full CI in the Agent’s security settings', async () => {
  render(<AgentPermissions />)
  const permission = screen.getByRole('checkbox', { name: 'Allow full-suite CI' })
  expect(permission).not.toBeChecked()
  await userEvent.click(permission)
  expect(permission).toBeChecked()
  await userEvent.click(permission)
  expect(permission).not.toBeChecked()
})

it('does not offer full CI through the global harness defaults editor', () => {
  render(<HarnessSectionFields editor={createHarnessEditor(DEFAULT_HARNESS_DEFAULTS.codex)}
    onChange={() => {}} section="permissions" />)
  expect(screen.queryByRole('checkbox', { name: 'Allow full-suite CI' })).not.toBeInTheDocument()
})

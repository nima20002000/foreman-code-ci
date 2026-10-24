import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { cleanup, render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { afterEach, expect, it } from 'vitest'
import { OperatorChatVisibilityProvider } from './visibility'
import { useOperatorChatVisibility } from './useOperatorChatVisibility'
import { askOperator, useOperatorChatStore } from './operatorChatStore'

function Handoff() {
  const visible = useOperatorChatVisibility()
  return <><button onClick={() => askOperator('Change the Claude preset: ', { send: false })}>Edit defaults</button>
    {visible ? <section aria-label="Visible Operator">Change the Claude preset:</section> : null}</>
}
afterEach(() => { cleanup(); useOperatorChatStore.getState().reset() })
it('offers an explicit temporary chat handoff while the saved visibility preference stays hidden', async () => {
  const client = new QueryClient()
  const user = userEvent.setup()
  render(<QueryClientProvider client={client}><OperatorChatVisibilityProvider enabled={false}><Handoff /></OperatorChatVisibilityProvider></QueryClientProvider>)
  await user.click(screen.getByRole('button', { name: 'Edit defaults' }))
  expect(await screen.findByRole('dialog', { name: 'Operator chat is hidden' })).toBeVisible()
  expect(screen.queryByRole('region', { name: 'Visible Operator' })).not.toBeInTheDocument()
  await user.click(screen.getByRole('button', { name: 'Show Operator chat' }))
  expect(screen.getByRole('region', { name: 'Visible Operator' })).toBeVisible()
  expect(screen.queryByRole('dialog')).not.toBeInTheDocument()
  client.clear()
})

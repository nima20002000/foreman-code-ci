import { useState } from 'react'
import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { render, screen } from '@testing-library/react'
import userEvent from '@testing-library/user-event'
import { http, HttpResponse } from 'msw'
import { expect, it, vi } from 'vitest'
import type { SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import { server } from '../../mocks/server'
import { NodePlacementField } from './NodePlacementField'
import { usePlacementChoices } from './usePlacementChoices'
import { savedPlacementFixture as placement } from './fixtures'

it('renders readable recovered folder choices from discovery and keeps real setup failures visible', async () => {
  const scope = { workspaceId: 'workspace', workflowId: 'workflow', nodeId: 'node', agentConfigurationVersionId: 'configuration' }
  const recovered = { ...placement, projectRoot: `/runtime/${'a'.repeat(64)}`,
    rootBinding: { rootId: 'root-recovered', bindingRevision: 3 } }
  const failure = 'The project folder could not be read.'
  server.use(http.get('*/api/management/workspaces/:workspaceId/workflows/:workflowId/nodes/:nodeId/placement-choices',
    () => HttpResponse.json({ ...scope, pending: false, choices: [
      { id: 'recovered', label: 'Studio · foreman-code', placement: recovered, availability: 'ready', reason: null },
      { id: 'other', label: 'Studio · docs', placement: { ...placement, projectRoot: '/projects/docs' },
        availability: 'unavailable', reason: failure },
    ] })))
  const change = vi.fn()
  function Picker() {
    const choices = usePlacementChoices(scope, 'source-recovery')
    const [value, setValue] = useState<SavedNodePlacement>()
    return <NodePlacementField value={value} options={choices.options}
      onChange={next => { setValue(next); change(next) }} />
  }
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const view = render(<QueryClientProvider client={client}><Picker /></QueryClientProvider>)
  try {
    const choice = await screen.findByRole('option', { name: 'Studio · foreman-code' })
    expect(screen.getAllByRole('option')).toHaveLength(3)
    const user = userEvent.setup()
    await user.selectOptions(screen.getByRole('combobox', { name: 'Computer' }), choice)
    expect(change).toHaveBeenCalledExactlyOnceWith(recovered)
    await user.selectOptions(screen.getByRole('combobox'), screen.getByRole('option', { name: 'Studio · docs · unavailable' }))
    expect(screen.getByText(failure)).toBeVisible()
    expect(change).toHaveBeenCalledTimes(1)
    expect(screen.queryByRole('button', { name: /approve/i })).not.toBeInTheDocument()
  } finally { view.unmount(); client.clear() }
})

import { configure, screen } from '@testing-library/react'
import { expect, it } from 'vitest'
import { http, HttpResponse } from 'msw'
import { collaborationContractFixtures } from '@foreman-code/contracts'
import { server } from '../../mocks/server'
import { boardHref, installBoardTestLifecycle, mountMeasuredBoard } from './eng05D.testSupport'
import { inspectionBoardFixture } from './inspect/inspectionFixtures'

installBoardTestLifecycle()
configure({ asyncUtilTimeout: 1000 })

it.each(['workflow_execution', 'workflow_coordinator'] as const)('mounts the real %s chat through the production shell', async kind => {
  const fixture = await inspectionBoardFixture(`production-${kind}`)
  const { scope, version } = fixture.runs.before
  const node = version.definition.nodes[0]!
  const agent = { ...collaborationContractFixtures.agent, workspaceId: scope.workspaceId, workflowId: scope.workflowId,
    workflowNodeId: node.id, agentId: node.kind === 'job' ? 'agent' : node.agentId,
    configurationVersionId: version.agentConfigurationVersionIds[node.kind === 'job' ? 'agent' : node.agentId]! }
  const target = kind === 'workflow_execution'
    ? { kind, agent, execution: { ...collaborationContractFixtures.execution, runId: scope.runId,
      workflowVersionId: scope.workflowVersionId, executionId: 'selected-execution' } }
    : { kind, agent, runId: scope.runId, waitingActivationId: 'waiting-master' }
  const root = `/api/workspaces/${scope.workspaceId}/workflows/${scope.workflowId}/execution-chat`
  server.use(...fixture.mock.handlers,
    http.get(`${root}/target`, () => HttpResponse.json({ kind: 'selected', target, agent,
      workflowVersionId: scope.workflowVersionId, source: kind === 'workflow_execution' ? 'execution' : 'consultation',
      state: kind === 'workflow_execution' ? 'active' : 'waiting_children' })),
    http.post(`/api/workspaces/${scope.workspaceId}/agent-chat/deliveries/read`, async ({ request }) => {
      const input = await request.json() as { deliveryInputs?: unknown }
      if (input.deliveryInputs) return HttpResponse.json({ target, deliveryInputs: { items: [], nextCursor: null, hasMore: false } })
      return HttpResponse.json({ target, state: 'waiting_children', messages: [], receipts: [], nextCursor: null,
        hasMore: false, revision: 0, capabilities: { steer: 'unavailable', queue: true, interruptAndSend: false } })
    }),
  )
  const params = new URLSearchParams({ boardPanel: 'agent', boardAgentTab: 'chat', boardNodeId: node.id,
    ...(kind === 'workflow_execution' ? { boardExecutionId: 'selected-execution' } : { boardWaitingActivationId: 'waiting-master' }) })
  await mountMeasuredBoard(`${boardHref(scope)}&${params}`)
  expect(await screen.findByRole('region', { name: 'Selected execution chat' })).toBeVisible()
  expect(screen.getByRole('textbox', { name: 'Message' })).toBeVisible()
  if (kind === 'workflow_coordinator') expect(screen.getByText('Stops this reply; delegated work continues.')).toBeVisible()
})

import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RepeatGraphCurrentV3Schema, repeatGraphTopologyV3 } from '@foreman-code/contracts/wave25'
import { server } from '../../mocks/server'
import { WorkflowBoardContext } from '../workflow-board/context'
import { RunBoardCanvas } from './RunBoardCanvas'
import { runA, versionReply } from './testFixtures'
import { installFlowLayout } from './testFlowLayout'

const digest = `sha256:${'1'.repeat(64)}`
const { scope, version } = versionReply(runA)
const identity = (node: string) => ({ workflowNodeId: node, executionId: `exec-${node}`, agentId: `agent-${node.slice(5)}`,
  agentConfigurationVersionId: version.agentConfigurationVersionIds[`agent-${node.slice(5)}`]!, attempt: 1, occurrence: null })
// X has finished and handed its result to Y, which is now working on it.
const current = RepeatGraphCurrentV3Schema.parse({
  kind: 'current', protocolVersion: 1, scope, topology: repeatGraphTopologyV3(version),
  asOfSequence: '2', retentionFloor: '0', historyCoverage: 'from_admission',
  state: { run: { executionState: 'running', outcome: 'pending', stopRequested: false,
    cleanupPending: false, unsettledReviewCount: 0, pendingInteractionCount: 0 },
    nodes: [], inputBindings: [], interactions: [], reviews: [], occurrences: [], resolutions: [], decisions: [], results: [{ execution: identity('node-x'), resultDigest: digest }],
    executions: [
      { identity: identity('node-x'), inputDigest: digest, previousExecutionId: null, state: 'completed', resultOutcome: 'succeeded' },
      { identity: identity('node-y'), inputDigest: digest, previousExecutionId: null, state: 'running', resultOutcome: null },
    ],
    bindings: [{ bindingId: 'binding-xy', kind: 'predecessor', relationshipId: 'edge-xy', decisionId: null,
      sender: identity('node-x'), recipient: identity('node-y'), acceptedResultDigest: digest, inputDigest: digest, ordinal: 0 }] },
})

beforeEach(() => {
  installFlowLayout()
  server.use(
    http.get('*/api/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/graph/v1/current', () => HttpResponse.json(current)),
    http.get('*/api/management/workspaces/:workspaceId/runs/:runId/subagents', () =>
      HttpResponse.json({ items: [], nextCursor: null, projection: 'caught-up' })),
    http.get('*/api/management/workspaces/:workspaceId/ci', () => HttpResponse.json({ runId: runA.runId, jobs: [], truncated: false })))
})
afterEach(() => { cleanup(); vi.restoreAllMocks() })

it('lights the line between two Agents when one hands its work to the next during a Run', async () => {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const board = { workspaceId: runA.workspaceId, workflowId: runA.workflowId, inspection: {}, activeRuns: 1,
    selectRun: vi.fn(), selectInspection: vi.fn(), openLocation: vi.fn(), openRuns: vi.fn() }
  const router = createRouter({ routeTree: createRootRoute({ component: () => <WorkflowBoardContext.Provider value={board}>
    <RunBoardCanvas snapshot={runA} /></WorkflowBoardContext.Provider> }), history: createMemoryHistory({ initialEntries: ['/'] }) })
  await router.load()
  const { container } = render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>)
  const line = (id: string) => container.querySelector(`[data-testid="rf__edge-${id}"]`)
  const node = (id: string) => container.querySelector(`[data-testid="rf__node-${id}"]`)
  await waitFor(() => expect(line('edge-xy')?.querySelector('.n-signal-edge-flight')).toHaveTextContent('Handoff'))
  expect(line('edge-yz')).not.toBeNull()
  expect(line('edge-yz')?.querySelector('.n-signal-edge-flight')).toBeNull()
  // Y takes up the work once the light reaches it.
  await waitFor(() => expect(node('node-y')).toHaveTextContent('Running'), { timeout: 3000 })
  expect(line('edge-xy')?.querySelector('.n-signal-edge-flight')).toBeNull()
})

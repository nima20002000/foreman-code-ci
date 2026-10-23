import { QueryClient, QueryClientProvider } from '@tanstack/react-query'
import { createMemoryHistory, createRootRoute, createRouter, RouterProvider } from '@tanstack/react-router'
import { cleanup, render, waitFor } from '@testing-library/react'
import { http, HttpResponse } from 'msw'
import { afterEach, beforeEach, expect, it, vi } from 'vitest'
import { RepeatGraphCurrentStateSchema, repeatGraphTopologyCurrent } from '@foreman-code/contracts/current'
import { server } from '../../mocks/server'
import { WorkflowBoardProvider } from '../board-core'
import { RunBoardCanvas } from './RunBoardCanvas'
import { runA, versionReply } from './testFixtures'
import { installFlowLayout } from './testFlowLayout'

const digest = `sha256:${'1'.repeat(64)}`
const { scope, version } = versionReply(runA)
const identity = (node: string) => ({ workflowNodeId: node, executionId: `exec-${node}`, agentId: `agent-${node.slice(5)}`,
  agentConfigurationVersionId: version.agentConfigurationVersionIds[`agent-${node.slice(5)}`]!, attempt: 1, occurrence: null })
// X has finished and handed its result to Y, which is now working on it.
const current = RepeatGraphCurrentStateSchema.parse({
  kind: 'current', protocolVersion: 1, scope, topology: repeatGraphTopologyCurrent(version),
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

async function mount() {
  const client = new QueryClient({ defaultOptions: { queries: { retry: false } } })
  const board = { workspaceId: runA.workspaceId, workflowId: runA.workflowId, inspection: {}, activeRuns: 1,
    selectRun: vi.fn(), selectInspection: vi.fn(), openLocation: vi.fn(), openRuns: vi.fn() }
  const router = createRouter({ routeTree: createRootRoute({ component: () => <WorkflowBoardProvider value={board}>
    <RunBoardCanvas snapshot={runA} /></WorkflowBoardProvider> }), history: createMemoryHistory({ initialEntries: ['/'] }) })
  await router.load()
  return render(<QueryClientProvider client={client}><RouterProvider router={router} /></QueryClientProvider>).container
}

it('lights the line between two Agents when one hands its work to the next during a Run', async () => {
  const container = await mount()
  const line = (id: string) => container.querySelector(`[data-testid="rf__edge-${id}"]`)
  const node = (id: string) => container.querySelector(`[data-testid="rf__node-${id}"]`)
  await waitFor(() => expect(line('edge-xy')?.querySelector('.n-signal-edge-flight')).toHaveTextContent('Handoff'))
  expect(line('edge-yz')).not.toBeNull()
  expect(line('edge-yz')?.querySelector('.n-signal-edge-flight')).toBeNull()
  // Y takes up the work once the light reaches it.
  await waitFor(() => expect(node('node-y')).toHaveTextContent('Running'), { timeout: 3000 })
  expect(line('edge-xy')?.querySelector('.n-signal-edge-flight')).toBeNull()
})

it.each([
  ['a work request', { kind: 'request' }, 'Handoff'],
  ['a verdict sent back', { kind: 'return', outcome: 'needs_changes' }, 'Changes requested'],
] as const)('lights the line for %s between two Agents', async (_name, sent, word) => {
  // Work hand-offs start the receiver's work directly: no predecessor binding, only each execution's work.
  const worked = (node: string, activationId: string, state: 'completed' | 'running') => ({ identity: identity(node), inputDigest: digest,
    previousExecutionId: null, workActivationId: activationId, state, resultOutcome: state === 'completed' ? 'succeeded' : null })
  const transfer = { transferId: 'transfer-1', ...sent, relationshipId: 'edge-xy', fromNodeId: 'node-x',
    fromExecutionId: 'exec-node-x', toNodeId: 'node-y', toActivationId: 'activation-y' }
  server.use(
    http.get('*/api/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/graph/v1/current', () => HttpResponse.json({ ...current,
      state: { ...current.state, bindings: [], results: [],
        executions: [worked('node-x', 'activation-x', 'completed'), worked('node-y', 'activation-y', 'running')] } })),
    http.get('*/api/management/workspaces/:workspaceId/runs/:runId/handoffs', () => HttpResponse.json({ scope, policy: 'work',
      runState: 'running', connections: [], routes: [], notices: [], unresolved: [], directionWait: false, transfers: [transfer] })))
  const container = await mount()
  const flight = () => container.querySelector('[data-testid="rf__edge-edge-xy"] .n-signal-edge-flight')
  await waitFor(() => expect(flight()).toHaveTextContent(word))
  expect(flight()).not.toHaveAttribute('data-reversed')
  await waitFor(() => expect(container.querySelector('[data-testid="rf__node-node-y"]')).toHaveTextContent('Running'), { timeout: 3000 })
})

it('keeps the Orchestrator on its finished turn while the Worker result travels back to it', async () => {
  const worked = (node: string, executionId: string, activationId: string, state: 'completed' | 'running' | 'queued') => ({
    identity: { ...identity(node), executionId }, inputDigest: digest, previousExecutionId: null, workActivationId: activationId,
    state, resultOutcome: state === 'completed' ? 'succeeded' : null })
  const send = { transferId: 'request-1', kind: 'request', relationshipId: 'edge-xy', fromNodeId: 'node-x',
    fromExecutionId: 'exec-x-1', toNodeId: 'node-y', toActivationId: 'activation-y' }
  const back = { transferId: 'request-2', kind: 'request', relationshipId: 'edge-xy', fromNodeId: 'node-y',
    fromExecutionId: 'exec-y-1', toNodeId: 'node-x', toActivationId: 'activation-x-2' }
  let back_sent = false
  // The server commits each hand-off with the work it starts, so both reads always agree.
  server.use(
    http.get('*/api/workspaces/:workspaceId/workflows/:workflowId/runs/:runId/graph/v1/current', () => HttpResponse.json({ ...current,
      asOfSequence: back_sent ? '3' : '2', state: { ...current.state, bindings: [], results: [], executions: back_sent
        ? [worked('node-x', 'exec-x-1', 'activation-x-1', 'completed'), worked('node-y', 'exec-y-1', 'activation-y', 'completed'),
          worked('node-x', 'exec-x-2', 'activation-x-2', 'queued')]
        : [worked('node-x', 'exec-x-1', 'activation-x-1', 'completed'), worked('node-y', 'exec-y-1', 'activation-y', 'running')] } })),
    http.get('*/api/management/workspaces/:workspaceId/runs/:runId/handoffs', () => HttpResponse.json({ scope, policy: 'work',
      runState: 'running', connections: [], routes: [], notices: [], unresolved: [], directionWait: false,
      transfers: back_sent ? [send, back] : [send] })))
  const container = await mount()
  const node = (id: string) => container.querySelector(`[data-testid="rf__node-${id}"]`)
  await waitFor(() => expect(node('node-y')).toHaveTextContent('Running'), { timeout: 3000 })
  expect(node('node-x')).toHaveTextContent('Completed')
  back_sent = true
  const returning = () => container.querySelector('[data-testid="rf__edge-edge-xy"] .n-signal-edge-flight[data-reversed]')
  await waitFor(() => expect(returning()).toBeTruthy(), { timeout: 5000 })
  expect(node('node-x')).toHaveTextContent('Completed')
  expect(node('node-x')).not.toHaveTextContent('Not started')
}, 15_000)

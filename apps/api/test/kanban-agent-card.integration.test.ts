import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, MemoryBoardViewSchema, MemoryBoardWireSchemas,
  MemoryCardDetailSchema, newAgentForemanTools, type HarnessExecutionRequest, type MemoryCard } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkActivationInputSchema, WorkflowRunCurrentSchema } from '@foreman-code/contracts/current'
import { HarnessExecutionError } from '../src/modules/harnesses/errors.js'
import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { memoryCall, type MemoryRuntime } from './helpers/memoryWorkflow.js'
import { postgresEnabled } from './helpers/database.js'
import { insertProviderRun } from './helpers/checkpointRuntime.js'

function agentFixture(readOnly = false) {
  const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
  fixture.version.approval = { handler: 'native' }
  fixture.version.definition.approval = fixture.version.approval
  fixture.run.approval = fixture.version.approval
  fixture.configurations[0]!.graphqlTools = newAgentForemanTools('coder')
  fixture.configurations[0]!.harness = { harness: 'codex', model: 'synthetic-no-native-call', reasoningEffort: 'low',
    sandbox: readOnly ? 'read-only' : 'workspace-write', serviceTier: 'standard',
    advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' } }
  return fixture
}

it.runIf(postgresEnabled).each([false, true])('reuses one engine card across Runs with per-execution history and prompt identity (read-only: %s)', async readOnly => {
  const fixture = agentFixture(readOnly)
  const requests: HarnessExecutionRequest[] = []
  const runningCards: MemoryCard[][] = []
  let boardId: string
  const runtime: MemoryRuntime = await currentOperatorIntegration({ fixture, approvalNodeIds: [],
    managerFactory: () => {
      const manager = runtime.provider.connection()
      return { ...manager, async createSession(input) {
        if (!isWorkflowStart(input)) throw new Error('Expected workflow launch')
        requests.push(input.request)
        const board = MemoryBoardViewSchema.parse(await memoryCall(runtime.client, 'memory_board_get', { boardId }))
        runningCards.push(board.openColumns.flatMap(column => column.items))
        return manager.createSession(input)
      } }
    } })
  try {
    const scope = { kind: 'workflow', workspaceId: runtime.f.scope.workspaceId, workflowId: runtime.f.scope.workflowId }
    boardId = ((await memoryCall(runtime.client, 'memory_board_get', { scope })).board as { id: string }).id
    const runIds = [runtime.f.run.id]
    await runtime.engine.start(runIds[0]!)
    const run = WorkflowRunCurrentSchema.parse({ ...runtime.f.run, id: `run-${randomUUID()}` })
    await insertProviderRun(runtime.db.pool, { ...runtime.f, run })
    runIds.push(run.id)
    await runtime.engine.start(run.id)
    for (const runId of runIds) expect((await runtime.runs.get(runId))?.outcome).toBe('succeeded')
    const done = MemoryBoardWireSchemas.cards.parse(await memoryCall(runtime.client, 'memory_board_get', {
      boardId, view: 'cards', status: 'done' }))
    expect(done.items).toHaveLength(1)
    const card = done.items[0]!
    expect(card).toMatchObject({ title: fixture.version.definition.nodes[0]!.name, status: 'done', completionKind: 'completed',
      assignee: { workspaceId: scope.workspaceId, workflowId: scope.workflowId, workflowNodeId: fixture.version.entryNodeId, agentId: fixture.configurations[0]!.agentId } })
    expect(runningCards).toHaveLength(2)
    for (const cards of runningCards) expect(cards).toEqual([expect.objectContaining({ id: card.id, status: 'doing' })])
    const detail = MemoryCardDetailSchema.parse(await memoryCall(runtime.client, 'memory_board_get', {
      boardId, view: 'card', cardId: card.id, limit: 100 }))
    for (const request of requests) {
      expect(request.initialPrompt).toContain(card.id)
      if (!readOnly) expect(request.initialPrompt).toContain(`Your card on this workflow's Kanban is ${card.id} "${card.title}"`)
      const changes = detail.history.items.filter(change => change.provenance?.execution?.executionId === request.executionId)
      expect(changes.some(change => change.actor.kind === 'engine' && change.changes?.status?.after === 'doing')).toBe(true)
      expect(changes.some(change => change.actor.kind === 'engine' && change.changes?.status?.after === 'done')).toBe(true)
    }
    expect(detail.history.items.some(change => change.changes?.status?.before === 'done'
      && change.changes.status.after === 'doing' && change.changes.reason?.after === 'Working again')).toBe(true)
    const board = MemoryBoardViewSchema.parse(await memoryCall(runtime.client, 'memory_board_get', { boardId }))
    expect(board.counts).toMatchObject({ todo: 0, doing: 0, waiting_for_user: 0, blocked: 0, done: 1 })
  } finally { await runtime.close() }
}, 60000)

it.runIf(postgresEnabled)('blocks the engine card with the execution error and reuses it on the next successful Run', async () => {
  const fixture = agentFixture(true)
  const reason = 'The requested source is unavailable.'
  let fail = true
  const runtime: MemoryRuntime = await currentOperatorIntegration({ fixture, approvalNodeIds: [], managerFactory: () => {
    const manager = runtime.provider.connection()
    return { ...manager, async *startTurn(session, input) {
      for await (const event of manager.startTurn(session, input)) {
        yield event
        if (fail && event.type === 'turn.started') throw new HarnessExecutionError('SOURCE_UNAVAILABLE', reason, false)
      }
    } }
  } })
  try {
    await runtime.engine.start(runtime.f.run.id)
    expect((await runtime.runs.get(runtime.f.run.id))?.outcome).toBe('failed')
    const scope = { kind: 'workflow', workspaceId: runtime.f.scope.workspaceId, workflowId: runtime.f.scope.workflowId }
    const boardId = ((await memoryCall(runtime.client, 'memory_board_get', { scope })).board as { id: string }).id
    const blocked = MemoryBoardWireSchemas.cards.parse(await memoryCall(runtime.client, 'memory_board_get', {
      boardId, view: 'cards', status: 'blocked' }))
    expect(blocked.items).toHaveLength(1)
    const card = blocked.items[0]!
    expect(card).toMatchObject({ reason, assignee: { workflowNodeId: fixture.version.entryNodeId } })
    const detail = MemoryCardDetailSchema.parse(await memoryCall(runtime.client, 'memory_board_get', {
      boardId, view: 'card', cardId: card.id }))
    expect(detail.history.items).toContainEqual(expect.objectContaining({ actor: expect.objectContaining({ kind: 'engine' }),
      provenance: expect.objectContaining({ execution: expect.objectContaining({ runId: runtime.f.run.id }) }),
      changes: expect.objectContaining({ status: { before: 'doing', after: 'blocked' }, reason: { before: null, after: reason } }) }))
    fail = false
    const run = WorkflowRunCurrentSchema.parse({ ...runtime.f.run, id: `run-${randomUUID()}` })
    await insertProviderRun(runtime.db.pool, { ...runtime.f, run })
    await runtime.engine.start(run.id)
    expect((await runtime.runs.get(run.id))?.outcome).toBe('succeeded')
    const done = MemoryBoardWireSchemas.cards.parse(await memoryCall(runtime.client, 'memory_board_get', {
      boardId, view: 'cards', status: 'done' }))
    expect(done.items).toEqual([expect.objectContaining({ id: card.id, completionKind: 'completed', reason: null })])
  } finally { await runtime.close() }
}, 60000)

it.runIf(postgresEnabled)('keeps a same-title unrelated card separate from the Agent card', async () => {
  const fixture = agentFixture(true)
  const runtime = await currentOperatorIntegration({ fixture, approvalNodeIds: [] })
  try {
    const scope = { kind: 'workflow', workspaceId: runtime.f.scope.workspaceId, workflowId: runtime.f.scope.workflowId }
    const boardId = ((await memoryCall(runtime.client, 'memory_board_get', { scope })).board as { id: string }).id
    const node = fixture.version.definition.nodes[0]!
    const unrelated = await memoryCall(runtime.client, 'memory_card_create', { kind: 'card_create', boardId,
      card: { title: node.name, body: 'Owner notes', status: 'todo', completionKind: null, reason: null, assignee: null, linkedNodes: [] } })
    await runtime.engine.start(runtime.f.run.id)
    expect((await runtime.runs.get(runtime.f.run.id))?.outcome).toBe('succeeded')
    const done = MemoryBoardWireSchemas.cards.parse(await memoryCall(runtime.client, 'memory_board_get', {
      boardId, view: 'cards', status: 'done' }))
    expect(done.items).toHaveLength(1)
    expect(done.items[0]!.title).toMatch(new RegExp(`^${node.name} \\(.+\\)$`))
    expect(done.items[0]!.assignee?.workflowNodeId).toBe(node.id)
    const original = MemoryCardDetailSchema.parse(await memoryCall(runtime.client, 'memory_board_get', {
      boardId, view: 'card', cardId: (unrelated.card as { id: string }).id }))
    expect(original.card).toMatchObject({ title: node.name, body: 'Owner notes', status: 'todo', assignee: null })
  } finally { await runtime.close() }
}, 60000)

it.runIf(postgresEnabled)('reuses a reviewer card with unresolved findings across handoff rounds', async () => {
  const fixture = agentFixture(true)
  const coder = fixture.version.definition.nodes[0]!
  const reviewer = { ...coder, id: 'reviewer', name: 'Reviewer' }
  fixture.version.definition.nodes.push(reviewer)
  fixture.version.definition.edges = [{ id: 'review', kind: 'execution', source: coder.id, target: reviewer.id }]
  fixture.version.definition.handoffs = { contractVersion: 1 }
  fixture.version.definition.executionPolicy = { maxParallelism: 2, maxNodeExecutions: 4 }
  let round = 0
  const reviewExecutionIds: string[] = []
  const runtime = await currentOperatorIntegration({ fixture, approvalNodeIds: [], outputFor: (nodeId, request) => {
    if (nodeId === coder.id) {
      round += 1
      return { routing: { kind: 'finish' }, data: { latestDeliverable: { round }, remainingFindings: [] } }
    }
    const { work } = WorkActivationInputSchema.parse(request.input)
    if (work.kind !== 'work_request') throw new Error('The reviewer needs a handoff request')
    reviewExecutionIds.push(request.executionId)
    return { routing: { kind: 'return', requestId: work.request.requestId, outcome: round === 1 ? 'needs_changes' : 'accepted' },
      data: { latestDeliverable: { round }, remainingFindings: round === 1 ? ['The source still needs review.'] : [] } }
  } })
  try {
    await runtime.engine.start(runtime.f.run.id)
    expect((await runtime.runs.get(runtime.f.run.id))?.outcome).toBe('succeeded')
    expect(round).toBe(2)
    const scope = { kind: 'workflow', workspaceId: runtime.f.scope.workspaceId, workflowId: runtime.f.scope.workflowId }
    const board = MemoryBoardViewSchema.parse(await memoryCall(runtime.client, 'memory_board_get', { scope }))
    const blocked = MemoryBoardWireSchemas.cards.parse(await memoryCall(runtime.client, 'memory_board_get', {
      boardId: board.board.id, view: 'cards', status: 'blocked' }))
    expect(blocked.items).toEqual([expect.objectContaining({ assignee: expect.objectContaining({ workflowNodeId: reviewer.id }) })])
    const detail = MemoryCardDetailSchema.parse(await memoryCall(runtime.client, 'memory_board_get', {
      boardId: board.board.id, view: 'card', cardId: blocked.items[0]!.id }))
    expect(detail.bindings).toHaveLength(2)
    expect(detail.bindings).toContainEqual(expect.objectContaining({ state: 'accepted', currentExecutionId: reviewExecutionIds[1] }))
    const previous = detail.bindings.find(binding => binding.state === 'blocked')
    expect(previous).toMatchObject({ reason: 'The source still needs review.', currentExecutionId: reviewExecutionIds[0] })
    expect(previous?.resolution).toBeUndefined()
    const details = await runtime.runs.getDetails(scope.workspaceId, runtime.f.run.id)
    const reviews = details!.executions.filter(execution => execution.workflowNodeId === reviewer.id)
    expect(reviews).toHaveLength(2)
    expect(reviewExecutionIds).toHaveLength(2)
    // Run details are ordered by execution ID, not handoff round.
    expect(reviews.find(execution => execution.id === reviewExecutionIds[0])?.result).toMatchObject({ outcome: 'succeeded', output: {
      routing: { kind: 'return', outcome: 'needs_changes' },
      data: { latestDeliverable: { round: 1 }, remainingFindings: ['The source still needs review.'] } } })
    expect(reviews.find(execution => execution.id === reviewExecutionIds[1])?.result).toMatchObject({ outcome: 'succeeded', output: {
      routing: { kind: 'return', outcome: 'accepted' },
      data: { latestDeliverable: { round: 2 }, remainingFindings: [] } } })
  } finally { await runtime.close() }
}, 60000)

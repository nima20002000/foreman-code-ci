import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, MemoryBoardViewSchema, MemoryBoardWireSchemas,
  MemoryCardDetailSchema, newAgentGraphqlTools, type HarnessExecutionRequest, type MemoryCard } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, WorkflowRunV3Schema } from '@foreman-code/contracts/wave25'
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
  fixture.configurations[0]!.graphqlTools = newAgentGraphqlTools('coder')
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
    const run = WorkflowRunV3Schema.parse({ ...runtime.f.run, id: `run-${randomUUID()}` })
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
    const run = WorkflowRunV3Schema.parse({ ...runtime.f.run, id: `run-${randomUUID()}` })
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

it.runIf(postgresEnabled)('reuses an Agent card with unresolved findings without resolving nonterminal work', async () => {
  const fixture = agentFixture(true)
  fixture.version.definition.handoffs = { contractVersion: 1 }
  let findings = ['The source still needs review.']
  const runtime = await currentOperatorIntegration({ fixture, approvalNodeIds: [], outputFor: () => ({
    routing: { kind: 'finish' }, data: { latestDeliverable: { text: 'Inspected the source' }, remainingFindings: findings },
  }) })
  try {
    await expect(runtime.engine.start(runtime.f.run.id)).rejects.toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED' })
    const scope = { kind: 'workflow', workspaceId: runtime.f.scope.workspaceId, workflowId: runtime.f.scope.workflowId }
    const board = MemoryBoardViewSchema.parse(await memoryCall(runtime.client, 'memory_board_get', { scope }))
    const cards = board.openColumns.flatMap(column => column.items)
    expect(cards).toHaveLength(1)
    const card = cards[0]!
    expect(card).toMatchObject({ status: 'blocked', reason: expect.stringContaining(findings[0]!) })
    findings = []
    const run = WorkflowRunV3Schema.parse({ ...runtime.f.run, id: `run-${randomUUID()}` })
    await insertProviderRun(runtime.db.pool, { ...runtime.f, run })
    await runtime.engine.start(run.id)
    expect((await runtime.runs.get(run.id))?.outcome).toBe('succeeded')
    const detail = MemoryCardDetailSchema.parse(await memoryCall(runtime.client, 'memory_board_get', {
      boardId: board.board.id, view: 'card', cardId: card.id }))
    expect(detail.bindings.items).toHaveLength(2)
    expect(detail.bindings.items).toContainEqual(expect.objectContaining({ work: expect.objectContaining({ runId: run.id }), state: 'accepted' }))
    const previous = detail.bindings.items.find(binding => binding.work.runId === runtime.f.run.id)
    expect(previous).toMatchObject({ state: 'blocked', reason: 'The source still needs review.' })
    expect(previous?.resolution).toBeUndefined()
    expect((await runtime.runs.get(runtime.f.run.id))?.outcome).toBe('failed')
  } finally { await runtime.close() }
}, 60000)

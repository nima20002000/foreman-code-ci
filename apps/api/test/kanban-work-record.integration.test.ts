import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, newAgentGraphqlTools, MemoryBoardViewSchema, MemoryCardDetailSchema, type HarnessExecutionRequest } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/current'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE } from '../src/modules/access/workerCredentials.js'
import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { correctiveNativeManager, type CorrectiveRequest } from './helpers/correctiveNativeManager.js'
import { memoryCall, type MemoryRuntime } from './helpers/memoryWorkflow.js'
import { postgresEnabled } from './helpers/database.js'

it.runIf(postgresEnabled).each(['silent', 'records', 'creates-other', 'updates-other', 'unchanged', 'read-only'] as const)(
  'a Worker is asked once only when it did not update its own workflow Kanban card (%s)', async mode => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'single')
    // Native approvals keep the configured sandbox; other fixtures replace it.
    fixture.version.approval = { handler: 'native' }
    fixture.version.definition.approval = fixture.version.approval
    fixture.run.approval = fixture.version.approval
    const configuration = fixture.configurations[0]!
    configuration.graphqlTools = newAgentGraphqlTools('coder')
    configuration.harness = { harness: 'codex', model: 'synthetic-no-native-call', reasoningEffort: 'low',
      sandbox: mode === 'read-only' ? 'read-only' : 'workspace-write', serviceTier: 'standard',
      advanced: { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' } }
    const node = fixture.version.definition.nodes[0]!
    const output = { node: node.id }
    const repairs: CorrectiveRequest[] = []
    let request: HarnessExecutionRequest | undefined
    let boardId: string
    let ownCardId: string | undefined
    let otherCardId: string
    const runtime: MemoryRuntime = await currentOperatorIntegration({ fixture, approvalNodeIds: [],
      managerFactory: () => {
        const manager = runtime.provider.connection()
        let token: string
        const recording = { ...manager,
          async createSession(input: Parameters<typeof manager.createSession>[0]) {
            if (!isWorkflowStart(input)) throw new Error('Expected workflow launch')
            request = input.request
            token = input.environment!.variables[APP_MCP_TOKEN_ENVIRONMENT_VARIABLE]!
            return manager.createSession(input)
          },
          async *startTurn(session: Parameters<typeof manager.startTurn>[0], input: Parameters<typeof manager.startTurn>[1]) {
            const board = MemoryBoardViewSchema.parse(await memoryCall(runtime.client, 'memory_board_get', { boardId }))
            const own = board.openColumns.flatMap(column => column.items).find(card => card.assignee?.workflowNodeId === node.id)
            ownCardId = own?.id
            if (mode === 'records' || mode === 'unchanged' || mode === 'updates-other') {
              const agent = await runtime.connect(token)
              await memoryCall(agent, 'memory_card_update', { kind: 'card_update', boardId,
                cardId: mode === 'updates-other' ? otherCardId : own!.id,
                patch: mode === 'unchanged' ? { body: own!.body } : { body: 'Found the answer.' } })
            } else if (mode === 'creates-other') {
              const agent = await runtime.connect(token)
              await memoryCall(agent, 'memory_card_create', { kind: 'card_create', boardId,
                card: { title: 'Unrelated work', body: '', status: 'doing', completionKind: null,
                  reason: null, assignee: null, linkedNodes: [] } })
            }
            yield* manager.startTurn(session, input)
          },
        }
        return correctiveNativeManager(recording, repairs, () => ({ outcome: 'succeeded', output }))
      },
    })
    try {
      const scope = { kind: 'workflow', workspaceId: runtime.f.scope.workspaceId, workflowId: runtime.f.scope.workflowId }
      boardId = ((await memoryCall(runtime.client, 'memory_board_get', { scope })).board as { id: string }).id
      otherCardId = ((await memoryCall(runtime.client, 'memory_card_create', { kind: 'card_create', boardId,
        card: { title: 'Other task', body: '', status: 'todo', completionKind: null,
          reason: null, assignee: null, linkedNodes: [] } })).card as { id: string }).id
      const runId = runtime.f.run.id
      await runtime.engine.start(runId)
      await vi.waitFor(async () => expect((await runtime.runs.get(runId))?.outcome).toBe('succeeded'),
        { timeout: 30000, interval: 50 })
      if (mode === 'read-only') expect(request?.initialPrompt ?? '').not.toContain('Kanban')
      else expect(request?.initialPrompt).toContain('Kanban')
      expect(ownCardId).toBeDefined()
      const reminded = !['records', 'read-only'].includes(mode)
      expect(repairs).toHaveLength(reminded ? 1 : 0)
      if (reminded) {
        expect(repairs[0]!.prompt).toContain('Kanban')
        expect(repairs[0]!.prompt).toContain(`update your card ${ownCardId}`)
        expect(repairs[0]!.prompt).toContain('memory_card_update')
        expect(repairs[0]!.prompt).toMatch(/do not create new cards/i)
      }
      expect(runtime.provider.startedExecutions).toHaveLength(1)
      const details = await runtime.runs.getDetails(scope.workspaceId, runId)
      expect(details?.executions[0]?.result).toEqual({ outcome: 'succeeded', output })
      const detail = MemoryCardDetailSchema.parse(await memoryCall(runtime.client, 'memory_board_get', {
        boardId, view: 'card', cardId: ownCardId }))
      expect(detail.card.status).toBe('done')
      if (mode === 'records') expect(detail.card.body).toBe('Found the answer.')
      if (mode !== 'read-only') {
        expect(request?.initialPrompt).toContain(`Your card on this workflow's Kanban is ${ownCardId}`)
        expect(request?.initialPrompt).toMatch(/Do not create new cards for your own work/)
      }
    } finally { await runtime.close() }
  }, 60000)

import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION, newAgentGraphqlTools, type HarnessExecutionRequest } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { APP_MCP_TOKEN_ENVIRONMENT_VARIABLE } from '../src/modules/access/workerCredentials.js'
import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { correctiveNativeManager, type CorrectiveRequest } from './helpers/correctiveNativeManager.js'
import { memoryCall, type MemoryRuntime } from './helpers/memoryWorkflow.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

it.runIf(postgresEnabled).each(['silent', 'records', 'read-only'] as const)(
  'a new Worker is told to record its work on the workflow Kanban and asked once when it did not (%s)', async mode => {
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
    let recordedCardId: string | undefined
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
            if (mode === 'records') {
              const agent = await runtime.connect(token)
              recordedCardId = ((await memoryCall(agent, 'memory_card_create', { kind: 'card_create', boardId,
                card: { title: 'Worker task', body: '', status: 'doing', completionKind: null,
                  reason: null, assignee: null, linkedNodes: [] } })).card as { id: string }).id
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
      const runId = runtime.f.run.id
      await runtime.engine.start(runId)
      await vi.waitFor(async () => expect((await runtime.runs.get(runId))?.outcome).toBe('succeeded'),
        { timeout: 30000, interval: 50 })
      if (mode === 'read-only') expect(request?.initialPrompt ?? '').not.toContain('Kanban')
      else expect(request?.initialPrompt).toContain('Kanban')
      expect(repairs).toHaveLength(mode === 'silent' ? 1 : 0)
      if (mode === 'silent') {
        expect(repairs[0]!.prompt).toContain('Kanban')
        expect(repairs[0]!.prompt).toMatch(/memory_card_create/)
      }
      expect(runtime.provider.startedExecutions).toHaveLength(1)
      const details = await runtime.runs.getDetails(scope.workspaceId, runId)
      expect(details?.executions[0]?.result).toEqual({ outcome: 'succeeded', output })
      if (mode === 'records') expect(await memoryCall(runtime.client, 'memory_board_get', { boardId, view: 'card',
        cardId: recordedCardId })).toMatchObject({ card: { title: 'Worker task' } })
      else expect(recordedCardId).toBeUndefined()
    } finally { await runtime.close() }
  }, 60000)

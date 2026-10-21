import { expect, it, vi } from 'vitest'
import { memoryBoardTools } from '@foreman-code/contracts'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { prepareCoordinationWorkflow } from './helpers/coordinationWorkflow.js'
import { correctiveNativeManager, type CorrectiveRequest } from './helpers/correctiveNativeManager.js'
import { memoryCall, memoryWorkflow, type MemoryRuntime } from './helpers/memoryWorkflow.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

it.runIf(postgresEnabled)('repairs a late card revision conflict before closing the native lifetime', async () => {
  const fixture = memoryWorkflow('single')
  fixture.configurations[0]!.graphqlTools = memoryBoardTools('write')
  fixture.configurations[0]!.harness.sandbox = 'workspace-write'
  const repairs: CorrectiveRequest[] = []
  let boardId: string, cardId: string
  let conflicted = false, settled = false
  const result = (revision: number) => ({ text: JSON.stringify({ routing: { kind: 'finish' },
    data: { latestDeliverable: { text: 'Complete' }, remainingFindings: [] }, summary: 'Completed work.',
    board: { kind: 'changes', operations: [{ kind: 'card_update', boardId, cardId,
      expectedRevision: revision, patch: { body: 'Agent update' } }] } }) })
  const runtime: MemoryRuntime = await currentOperatorIntegration({ fixture, insertRun: false, approvalNodeIds: [],
    outputFor: () => result(1),
    nativeSourcePersisted: async (_sql, _evidence, source) => {
      if (conflicted || source.original.type !== 'history' || !source.original.history.terminalTurn) return
      conflicted = true
      await memoryCall(runtime.client, 'memory_card_update', { kind: 'card_update', boardId, cardId,
        patch: { body: 'Concurrent operator update' } })
    },
    managerFactory: () => {
      const manager = correctiveNativeManager(runtime.provider.connection(), repairs,
        () => ({ outcome: 'succeeded', output: result(2) }))
      return { ...manager,
        async *startTurn(session, input, signal) {
          if (settled) throw new Error('The provider cannot accept turns after output settlement')
          yield* manager.startTurn(session, input, signal)
        },
        async settleTurn(session, correlationId, signal) {
          settled = true
          return manager.reconcile(session, correlationId, signal)
        },
      }
    },
  })
  try {
    const prepared = await prepareCoordinationWorkflow(runtime)
    boardId = prepared.boardId
    const created = await memoryCall(runtime.client, 'memory_card_create', { kind: 'card_create', boardId,
      card: { title: 'Concurrent edits', body: '', status: 'todo', completionKind: null,
        reason: null, assignee: null, linkedNodes: [] } })
    cardId = (created.card as { id: string }).id
    const started = await prepared.start()
    await vi.waitFor(async () => expect((await runtime.runs.get(started.run.id))?.outcome).toBe('succeeded'),
      { timeout: 30000, interval: 50 })
    expect(conflicted).toBe(true)
    expect(settled).toBe(true)
    expect(repairs).toHaveLength(1)
    expect(runtime.provider.startedExecutions).toHaveLength(1)
    expect(await memoryCall(runtime.client, 'memory_board_get', { boardId, view: 'card', cardId }))
      .toMatchObject({ card: { body: 'Agent update', revision: 3 } })
  } finally { await runtime.close() }
}, 60000)

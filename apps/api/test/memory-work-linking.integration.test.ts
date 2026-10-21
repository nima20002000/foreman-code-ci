import { expect, it } from 'vitest'
import { WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { isWorkflowStart } from '../src/modules/harnesses/sessionStart.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { memoryWorkflow, memoryCall, workflowMemory, type MemoryRuntime } from './helpers/memoryWorkflow.js'

it.runIf(postgresEnabled)('rejects Done and Drop when linking a parent whose accepted turn still owes child work', async () => {
  const fixture = memoryWorkflow()
  let memory: Awaited<ReturnType<typeof workflowMemory>>
  let linked: Record<string, unknown> | undefined
  const denials: unknown[] = []
  const runtime: MemoryRuntime = await currentOperatorIntegration({ fixture, approvalNodeIds: [],
    outputFor: (_node, request) => {
      const input = WorkActivationInputSchema.parse(request.input)
      return { routing: input.work.kind === 'work_request'
        ? { kind: 'return', requestId: input.work.request.requestId, outcome: 'accepted' } : { kind: 'finish' },
      data: { latestDeliverable: { text: 'Complete' }, remainingFindings: [] } }
    },
    managerFactory: () => {
      const manager = runtime.provider.connection()
      let child = false
      return { ...manager, async createSession(input) {
        if (!isWorkflowStart(input)) throw new Error('Expected workflow session')
        child = input.request.workflowNodeId !== fixture.version.entryNodeId
        return manager.createSession(input)
      }, async *startTurn(session, input) {
        if (child) {
          const current = await memory.read()
          const work = (current.bindings as Array<{ work: unknown }>)[0]!.work
          linked = await memoryCall(runtime.client, 'memory_card_create', { kind: 'card_create', boardId: memory.boardId,
            card: { title: 'Linked during review', body: '', status: 'doing', completionKind: null,
              reason: null, assignee: null, linkedNodes: [] }, workSelections: [{ kind: 'current', work }] })
          for (const completionKind of ['completed', 'dropped']) {
            const reply = await runtime.client.callTool({ name: 'memory_card_update', arguments: {
              kind: 'card_update', boardId: memory.boardId, cardId: (linked.card as { id: string }).id,
              patch: { status: 'done', completionKind, reason: 'Explicit request during review' },
            } })
            denials.push(reply)
          }
        }
        yield* manager.startTurn(session, input)
      } }
    },
  })
  try {
    memory = await workflowMemory(runtime)
    await runtime.engine.start(runtime.f.run.id)
    expect(linked).toMatchObject({ bindings: [{ state: 'waiting_children' }] })
    expect(denials).toHaveLength(2)
    for (const denial of denials) expect(denial).toMatchObject({ isError: true })
    const detail = await memoryCall(runtime.client, 'memory_board_get', { boardId: memory.boardId,
      view: 'card', cardId: (linked!.card as { id: string }).id })
    expect(detail).toMatchObject({ card: { status: 'done', completionKind: 'completed' }, bindings: [{ state: 'accepted' }] })
  } finally { await runtime.close() }
}, 60000)

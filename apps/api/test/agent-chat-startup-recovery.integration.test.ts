import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/current'
import { conversationDeliveryFixture } from '../src/modules/conversations/conversationDelivery.test-support.js'
import { seedWorkflowFixture } from './helpers/workflowDatabase.js'
import { postgresEnabled } from './helpers/database.js'

describe.skipIf(!postgresEnabled)('Agent chat startup recovery isolation', () => {
  it.each(['restoreUnsettled', 'unconfirmedSteers'] as const)(
    'recovers later queued conversations and retries a transient %s failure', async operation => {
      const f = await conversationDeliveryFixture()
      try {
        const definition = makeCurrentWorkflowFixture(`recovery-${randomUUID()}`, 'single')
        definition.configurations = definition.configurations.map(configuration => ({ ...configuration,
          harness: f.saved.configurations[0]!.harness }))
        const second = await seedWorkflowFixture(f.database.pool, f.database.directory, definition, { run: false })
        const node = second.version.definition.nodes[0]!
        const contexts = [{ workspaceId: f.scope.workspaceId, ...f.query },
          { workspaceId: second.scope.workspaceId, workflowId: second.scope.workflowId,
            workflowNodeId: node.id, agentId: node.agentId }]
        // Leave durable owner-admitted queues as if Main stopped before native dispatch.
        const dispatch = vi.spyOn(f.agent, 'dispatchAdmittedDelivery').mockResolvedValue(undefined)
        const ids: string[] = []
        for (const context of contexts) {
          const target = (await f.agent.read(f.owner, context.workspaceId, context)).deliveryTarget
          if (target?.kind !== 'agent_conversation') throw new Error('Expected an Agent conversation target.')
          const native = f.native(target.conversationId)
          const create = native.createSession.bind(native)
          vi.spyOn(native, 'createSession').mockImplementation(async () => ({ ...await create(),
            nativeSessionId: `native-${target.conversationId}` }))
          await f.feature.router.send(f.owner, { commandId: randomUUID(), target, content: 'Recover this queued input', intent: 'next_turn' })
          ids.push(target.conversationId)
        }
        dispatch.mockRestore()
        await f.restart()
        expect((await f.agentRepository.open()).map(row => row.id)).toEqual(ids)
        const fault = vi.spyOn(f.agentRepository, operation).mockRejectedValueOnce(new Error('Transient recovery storage failure'))
        try {
          await expect(f.agent.recover()).resolves.toBeUndefined()
          await vi.waitFor(async () => {
            const state = await f.agent.read(f.owner, contexts[1]!.workspaceId, contexts[1]!)
            expect(state.turns[0]?.delivery).toBe('completed')
          })
          // No second recover() call or user send is needed for the failed conversation.
          await vi.waitFor(async () => {
            const state = await f.agent.read(f.owner, contexts[0]!.workspaceId, contexts[0]!)
            expect(state.turns[0]?.delivery).toBe('completed')
          }, { timeout: 5_000 })
          for (const id of ids) expect(f.native(id).inputs).toHaveLength(1)
        } finally { fault.mockRestore() }
      } finally { await f.close() }
    })
})

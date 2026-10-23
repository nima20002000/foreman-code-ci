import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { conversationDeliveryFixture } from '../src/modules/conversations/conversationDelivery.test-support.js'
import { postgresEnabled, seedAgent3 } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('Agent chat startup recovery isolation', () => {
  it.each(['restoreUnsettled', 'unconfirmedSteers'] as const)(
    'recovers later queued conversations and retries a transient %s failure', async operation => {
      const f = await conversationDeliveryFixture()
      try {
        const definition = makeCurrentWorkflowFixture(`recovery-${randomUUID()}`, 'single')
        definition.configurations = definition.configurations.map(configuration => ({ ...configuration,
          harness: f.saved.configurations[0]!.harness }))
        const second = await seedAgent3(f.database.pool, f.database.directory, definition, { run: false })
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
          await f.feature.router.send(f.owner, { commandId: randomUUID(), target, content: 'Recover this queued input', intent: 'next_turn' })
          ids.push(target.conversationId)
        }
        dispatch.mockRestore()
        await f.restart()
        expect((await f.agentRepository.open()).map(row => row.id)).toEqual(ids)
        const original = f.agentRepository[operation].bind(f.agentRepository)
        let failed = false
        const fault = vi.spyOn(f.agentRepository, operation).mockImplementation(async id => {
          if (id === ids[0] && !failed) { failed = true; throw new Error('Transient recovery storage failure') }
          return original(id)
        })
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

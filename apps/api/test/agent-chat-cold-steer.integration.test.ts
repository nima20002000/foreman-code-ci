import { describe, expect, it, vi } from 'vitest'
import { conversationDeliveryFixture } from '../src/modules/conversations/conversationDelivery.test-support.js'
import { postgresEnabled } from './helpers/database.js'

describe.skipIf(!postgresEnabled)('Agent chat prepared steer after Main restart', () => {
  it('attaches the retained live native turn before delivering a prepared steer', async () => {
    const f = await conversationDeliveryFixture()
    try {
      const selected = (await f.agent.read(f.owner, f.scope.workspaceId, f.query)).deliveryTarget
      if (selected?.kind !== 'agent_conversation') throw new Error('Expected an Agent conversation target.')
      const native = f.native(selected.conversationId)
      native.autoFinish = false
      await f.feature.router.send(f.owner, { target: selected, commandId: 'active', content: 'Keep working', intent: 'next_turn' })
      await vi.waitFor(async () => expect((await f.agentRepository.turn(selected.conversationId, 'active'))?.delivery).toBe('accepted'))
      const original = (await f.agentRepository.get(selected.conversationId))!
      const owner = f.agent.createDeliveryOwner(f.feature.repository)
      vi.spyOn(owner, 'deliver').mockRejectedValueOnce(new Error('Native owner is temporarily unavailable'))
      const receipt = await f.feature.router.send(f.owner, { target: selected, commandId: 'prepared-steer',
        content: 'Include recovery', intent: 'steer' })
      expect((await f.feature.repository.byReceipt(receipt.id))?.ownerAdmission).toBe('prepared')
      await f.restart()
      // Exercise the pending drain before startup recovery has attached any local runtime.
      await f.feature.router.drainPrepared()
      const read = await f.feature.router.read(f.owner, { target: selected })
      expect(read.receipts.find(entry => entry.id === receipt.id)).toMatchObject({ state: 'accepted', appliedIntent: 'steer' })
      expect(native.steers).toHaveLength(1)
      expect(native.steers[0]).toMatchObject({ expectedTurnId: original.active_native_turn_id })
      expect(await f.agentRepository.get(selected.conversationId)).toMatchObject({
        native_session_id: original.native_session_id, active_request_id: original.active_request_id,
        active_native_turn_id: original.active_native_turn_id,
      })
      await f.feature.router.drainPrepared()
      await f.agent.recover()
      expect(native.steers).toHaveLength(1)
      expect(native.sessions).toBe(1)
      expect(native.inputs).toHaveLength(1)
    } finally { await f.close() }
  })
})

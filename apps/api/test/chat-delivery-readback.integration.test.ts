import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { deliveryFixture, caller, target } from '../src/modules/workflow-chat/delivery.test-support.js'
import { assertChatCommandKind } from '../src/modules/workflow-chat/index.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import type { RetainedDeliveryInput } from '../src/modules/workflow-chat/retainedInputs.js'

describe('bounded direct delivery readback and command identity', () => {
  let f: Awaited<ReturnType<typeof deliveryFixture>>
  beforeEach(async () => { f = await deliveryFixture() })
  afterEach(async () => { await f.close() })

  it('budgets retained input pages including continuation metadata and recovers exact never-native content', async () => {
    f.change({ beforeAdoption: true })
    const content = '🙂"\\\n'.repeat(10_000)
    const ids: string[] = []
    for (let index = 0; index < 20; index++) ids.push((await f.delivery.send(caller, { target, commandId: `input-${index}`,
      intent: 'next_turn', content })).id)
    const rows: RetainedDeliveryInput[] = []
    let cursor: string | undefined
    do {
      const read = await f.delivery.read(caller, { target, deliveryInputs: { limit: 100, ...(cursor ? { cursor } : {}) } })
      if (!('deliveryInputs' in read) || !read.deliveryInputs) throw new Error('Expected retained input page.')
      expect(Buffer.byteLength(JSON.stringify(read.deliveryInputs))).toBeLessThanOrEqual(256 * 1024)
      rows.push(...read.deliveryInputs.items); cursor = read.deliveryInputs.nextCursor ?? undefined
    } while (cursor)
    expect(new Set(rows.map(row => row.receiptId))).toEqual(new Set(ids))
    let recovered = '', bodyCursor: string | undefined
    do {
      const read = await f.delivery.read(caller, { target, deliveryInputs: { receiptId: ids[0], ...(bodyCursor ? { bodyCursor } : {}) } })
      if (!('deliveryInputs' in read) || !read.deliveryInputs) throw new Error('Expected exact input page.')
      const row = read.deliveryInputs.items[0]!
      recovered += row.content; bodyCursor = row.bodyCursor ?? undefined
    } while (bodyCursor)
    expect(recovered).toBe(content)
    expect(f.nativeSubmissions()).toBe(0)
  })

  it('conflicts on the same actor command across workflows and between delivery and control', async () => {
    const request = { commandId: 'global-command', target, intent: 'next_turn', content: 'Original direct input' }
    const first = await f.delivery.send(caller, request)
    expect(await f.delivery.send(caller, request)).toEqual(first)
    await expect(f.delivery.send(caller, { ...request, target: { ...target, agent: { ...target.agent, workflowId: 'other-workflow' } } }))
      .rejects.toMatchObject({ code: 'CHAT_COMMAND_CONFLICT' })
    await expect(withTransaction(f.pool, tx => assertChatCommandKind(tx, caller.id, request.commandId, 'control')))
      .rejects.toMatchObject({ code: 'CHAT_COMMAND_CONFLICT' })
  })
})

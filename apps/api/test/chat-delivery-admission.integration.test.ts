import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { ChatDeliveryRouter } from '../src/modules/workflow-chat/delivery.js'
import { deliveryFixture, caller, target } from '../src/modules/workflow-chat/delivery.test-support.js'

describe('durable direct delivery admission', () => {
  let f: Awaited<ReturnType<typeof deliveryFixture>>
  beforeEach(async () => { f = await deliveryFixture() })
  afterEach(async () => { await f.close() })
  it('never resubmits after native acceptance loses its response, including public replay and restart', async () => {
    const input = { commandId: 'native-lost', target, intent: 'next_turn', content: 'Keep this exact input', attachments: [] }
    f.change({ afterNative: true })
    const receipt = await f.delivery.send(caller, input)
    expect(receipt.commandId).toBe('native-lost')
    f.change({ targetValid: false })
    expect(await f.delivery.send(caller, input)).toEqual(receipt)
    const restarted = new ChatDeliveryRouter(f.repository, f.targetAuthority, f.owner, f.owner, f.owner)
    await restarted.drainPrepared()
    expect(f.nativeSubmissions()).toBe(1)
    const read = await restarted.read(caller, { target, commandId: 'native-lost' })
    expect(read.receipts).toEqual([receipt])
  })

  it('replays before fresh target validation while enforcing read authorization and immutable input', async () => {
    const input = { commandId: 'replay', target, intent: 'next_turn', content: 'The original input' }
    const first = await f.delivery.send(caller, input)
    f.change({ targetValid: false })
    const restarted = new ChatDeliveryRouter(f.repository, f.targetAuthority, f.owner, f.owner, f.owner)
    expect(await restarted.send(caller, input)).toEqual(first)
    await expect(restarted.send(caller, { ...input, content: `${input.content}!` })).rejects.toMatchObject({ code: 'CHAT_COMMAND_CONFLICT' })
    f.change({ authorized: false })
    await expect(restarted.send(caller, input)).rejects.toMatchObject({ code: 'FORBIDDEN' })
  })

  it('resumes a crash before native owner adoption with one delivery', async () => {
    f.change({ beforeAdoption: true })
    const receipt = await f.delivery.send(caller, { commandId: 'before-adoption', target, intent: 'next_turn', content: 'Original input' })
    const restarted = new ChatDeliveryRouter(f.repository, f.targetAuthority, f.owner, f.owner, f.owner)
    f.change({ beforeAdoption: false })
    await Promise.all([restarted.drainPrepared(), f.delivery.drainPrepared()])
    expect(f.nativeSubmissions()).toBe(1)
    expect(await restarted.read(caller, { target, commandId: receipt.commandId })).toMatchObject({ receipts: [{ id: receipt.id, state: 'accepted' }] })
  })

  it('recovers never-native direct input through exact target-bound body continuation', async () => {
    f.change({ beforeAdoption: true })
    const content = '🙂 exact retained text\n'.repeat(8_000)
    const receipt = await f.delivery.send(caller, { commandId: 'retained', target, intent: 'next_turn', content,
      attachments: [{ fileId: 'file', revisionId: 'revision' }] })
    let bodyCursor: string | undefined
    let recovered = ''
    do {
      const read = await f.delivery.read(caller, { target, deliveryInputs: { receiptId: receipt.id,
        ...(bodyCursor ? { bodyCursor } : {}) } })
      if (!('deliveryInputs' in read) || !read.deliveryInputs) throw new Error('Expected retained input page')
      const row = read.deliveryInputs.items[0]!
      expect(row.target).toEqual(target)
      expect(row.attachments).toEqual([{ fileId: 'file', revisionId: 'revision' }])
      recovered += row.content
      bodyCursor = row.bodyCursor ?? undefined
    } while (bodyCursor)
    expect(recovered).toBe(content)
    expect(f.nativeSubmissions()).toBe(0)
    if (target.kind !== 'workflow_execution') throw new Error('Expected execution fixture')
    await expect(f.delivery.read(caller, { target: { ...target, execution: { ...target.execution, executionId: 'wrong' } },
      deliveryInputs: { receiptId: receipt.id } })).rejects.toMatchObject({ code: 'CHAT_INPUT_NOT_FOUND' })
  })
})

import { afterEach, describe, expect, it } from 'vitest'
import { operatorRepositoryFixture } from './helpers/operatorRepositoryFixture.js'

let fixture: Awaited<ReturnType<typeof operatorRepositoryFixture>> | undefined
afterEach(async () => { await fixture?.close(); fixture = undefined })

describe('repository terminal transition without assistant identity', () => {
  for (const nativeMessageId of [undefined, 'real-id']) it.each(['', { text: '' }, { content: '' }])(
    `settles once without text %j; nativeMessageId=${nativeMessageId}`, async output => {
      const f = fixture = await operatorRepositoryFixture()
      const result = { outcome: 'succeeded' as const, output }
      expect(await f.repository.finish(f.conversation.id, f.requestId, result, nativeMessageId)).toBe(true)
      expect(await f.repository.finish(f.conversation.id, f.requestId, { outcome: 'succeeded' }, nativeMessageId)).toBe(false)
      const saved = await f.repository.get(f.conversation.id)
      expect(saved?.messages.filter(message => message.role === 'assistant')).toEqual([])
      expect(saved).toMatchObject({ lastResult: result, activeRequestId: null, turnState: 'idle' })
      expect((await f.repository.history(f.conversation.id))?.entries[0]?.receipt).toMatchObject({ outcome: 'succeeded' })
    })
  it.each(['Exact\nprovider text', '   '])('retains exact nonempty provider text %j without trimming it', async content => {
    const f = fixture = await operatorRepositoryFixture()
    expect(await f.repository.finish(f.conversation.id, f.requestId, { outcome: 'succeeded', output: { text: content } }, 'real-id')).toBe(true)
    expect((await f.repository.get(f.conversation.id))?.messages.filter(message => message.role === 'assistant'))
      .toEqual([expect.objectContaining({ content, requestId: f.requestId, nativeMessageId: 'real-id', role: 'assistant' })])
  })
  it('does not fabricate a provider ID even when terminal result text exists', async () => {
    const f = fixture = await operatorRepositoryFixture()
    expect(await f.repository.finish(f.conversation.id, f.requestId, { outcome: 'succeeded', output: { text: 'Real text but no provider message identity' } })).toBe(true)
    expect((await f.repository.get(f.conversation.id))?.messages.filter(message => message.role === 'assistant')).toEqual([])
  })
})

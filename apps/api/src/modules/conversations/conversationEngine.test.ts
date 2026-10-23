import { describe, expect, it } from 'vitest'
import { DomainError } from '../errors.js'
import { NativeDeliveryError } from '../harnesses/errors.js'
import { ConversationControlQueue, conversationDeliveryState, definiteCreationRejection, definitePromptRejection,
  failedTurnResult, qualifyDeliveryIntent } from './conversationEngine.js'

const refused = (method: string) => Object.assign(new Error('refused'), { method, uncertain: false })

describe('native delivery evidence', () => {
  it('treats only a definite turn/start refusal as prompt rejection when the engine requires turn-start evidence', () => {
    expect(definitePromptRejection(refused('turn/start'), 'turn-start')).toBe(true)
    expect(definitePromptRejection(refused('thread/read'), 'turn-start')).toBe(false)
    expect(definitePromptRejection(refused('thread/read'), 'any-method')).toBe(true)
    expect(definitePromptRejection(Object.assign(new Error('maybe'), { method: 'turn/start', uncertain: true }), 'any-method')).toBe(false)
  })

  it('trusts the native write boundary and declared certainty before RPC evidence', () => {
    expect(definitePromptRejection(new NativeDeliveryError('turn_submission', 'not_sent', new Error('x')), 'turn-start')).toBe(true)
    expect(definitePromptRejection(new NativeDeliveryError('session_creation', 'not_sent', new Error('x')), 'any-method')).toBe(false)
    expect(definitePromptRejection(Object.assign(new Error('x'), { certainty: 'definite', method: 'thread/read' }), 'turn-start')).toBe(true)
    expect(definitePromptRejection('not an error', 'any-method')).toBe(false)
  })

  it('accepts declared provider certainty for creation only when the engine opts in', () => {
    const declared = Object.assign(new Error('x'), { certainty: 'definite' })
    expect(definiteCreationRejection(declared, true)).toBe(true)
    expect(definiteCreationRejection(declared, false)).toBe(false)
    expect(definiteCreationRejection(new NativeDeliveryError('session_creation', 'not_sent', new Error('x')), false)).toBe(true)
    expect(definiteCreationRejection(new NativeDeliveryError('session_creation', 'unknown', new Error('x')), true)).toBe(false)
  })

  it('keeps the provider code and message in a failed turn result', () => {
    const provider = Object.assign(new Error('outer'), { code: 'OUTER', result: { outcome: 'failed', error: { code: 'INNER', message: 'Provider said no', retryable: false } } })
    expect(failedTurnResult(provider, 'FALLBACK', 'Fallback')).toEqual({ outcome: 'failed', error: { code: 'INNER', message: 'Provider said no', retryable: true } })
    expect(failedTurnResult(undefined, 'FALLBACK', 'Fallback')).toEqual({ outcome: 'failed', error: { code: 'FALLBACK', message: 'Fallback', retryable: true } })
  })
})

describe('delivery qualification', () => {
  const messages = { steerUnavailable: 'cannot steer', notActive: 'not active' }
  it('resolves auto to steer only when the active turn can take it', () => {
    expect(qualifyDeliveryIntent('auto', { canSteer: true, active: true }, messages)).toBe('steer')
    expect(qualifyDeliveryIntent('auto', { canSteer: false, active: true }, messages)).toBe('next_turn')
    expect(qualifyDeliveryIntent('interrupt_and_send', { canSteer: false, active: true }, messages)).toBe('interrupt_and_send')
  })
  it('refuses a steer or an interrupt the conversation cannot take', () => {
    expect(() => qualifyDeliveryIntent('steer', { canSteer: false, active: true }, messages))
      .toThrow(expect.objectContaining({ code: 'CHAT_STEER_UNAVAILABLE', message: 'cannot steer' }))
    expect(() => qualifyDeliveryIntent('interrupt_and_send', { canSteer: false, active: false }, messages))
      .toThrow(expect.objectContaining({ code: 'CHAT_TURN_NOT_ACTIVE', message: 'not active' }))
  })
  it('reports the delivery state of a conversation row', () => {
    expect(conversationDeliveryState(undefined)).toBe('idle')
    expect(conversationDeliveryState({ turn_state: 'starting', active_request_id: 'r' })).toBe('starting')
    expect(conversationDeliveryState({ turn_state: 'uncertain', active_request_id: 'r' })).toBe('settling')
    expect(conversationDeliveryState({ turn_state: 'active', active_request_id: 'r' })).toBe('active')
  })
})

describe('control queue', () => {
  it('runs one conversation in order, continues after a failure and forgets settled work', async () => {
    const queue = new ConversationControlQueue()
    const order: string[] = []
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = queue.run('a', async () => { await gate; order.push('first') })
    const failed = queue.run('a', async () => { order.push('second'); throw new Error('second failed') })
    const third = queue.run('a', async () => { order.push('third'); return 3 })
    const other = queue.run('b', async () => { order.push('other') })
    await other
    expect(queue.has('a')).toBe(true)
    release()
    await first
    await expect(failed).rejects.toThrow('second failed')
    await expect(third).resolves.toBe(3)
    expect(order).toEqual(['other', 'first', 'second', 'third'])
    await Promise.allSettled(queue.pending())
    await new Promise(resolve => setTimeout(resolve, 0))
    expect(queue.size).toBe(0)
  })
  it('lets the admission guard refuse queued work', async () => {
    let closing = false
    const queue = new ConversationControlQueue(() => { if (closing) throw new DomainError('CLOSING', 'closing', 503) })
    let release!: () => void
    const gate = new Promise<void>(resolve => { release = resolve })
    const first = queue.run('a', () => gate)
    const second = queue.run('a', async () => 'ran')
    await new Promise(resolve => setTimeout(resolve, 0))
    closing = true
    release()
    await first
    await expect(second).rejects.toMatchObject({ code: 'CLOSING' })
  })
})

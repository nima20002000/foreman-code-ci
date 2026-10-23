import { describe, expect, it } from 'vitest'
import type { NativeHarnessEvent } from '@foreman-code/contracts'
import type { NativeHistory } from '../harnesses/port.js'
import { nativePersistenceRedactor } from '../interactions/nativePersistence.js'
import { consumeTurnOutput, createTurnTextPipeline, observedMessageReceipt, observedNonSubmission,
  type TurnEventSink } from './conversationTurnCore.js'

const event = (sequence: number, type: string, payload: Record<string, unknown> = {}): NativeHarnessEvent =>
  ({ sequence, type, occurredAt: '2026-10-01T00:00:00Z', payload })
const session = { harness: 'codex' as const, providerVersion: 'test', nativeSessionId: 'session-a' }

async function* stream(...events: NativeHarnessEvent[]) { for (const item of events) yield item }

function pipeline(sink: TurnEventSink, appended: string[]) {
  return createTurnTextPipeline({ id: 'chat-a', requestId: 'request-a', harness: 'codex', session,
    repository: { appendAssistantTextOperation: async (_id, _request, operation) => {
      appended.push(operation.text)
      return { status: 'committed', revision: '7', messageRevision: '1' }
    } },
    owner: () => ({ scope: { kind: 'operator_chat' as const, conversationId: 'chat-a' }, requestId: 'request-a',
      sessionId: session.nativeSessionId, turnId: 'turn-a' }),
    redact: nativePersistenceRedactor([]), signal: new AbortController().signal, events: sink, reconcileCommit: () => {} })
}

describe('shared chat turn core', () => {
  it('runs the engine hooks in order for each native event and asks for a pending interaction', async () => {
    const calls: string[] = []
    const sink: TurnEventSink = { publish: (type) => { calls.push(`publish:${type}`) } }
    const pending = event(2, 'permission.asked')
    await consumeTurnOutput(stream(event(1, 'turn.started'), pending), 'request-a', pipeline(sink, []), sink, {
      onOutput: () => calls.push('output'),
      nativeTurnId: () => 'turn-a',
      nativeSubmission: () => undefined,
      beforeText: async (item) => { calls.push(`before:${item.type}`) },
      admit: async (item) => { calls.push(`admit:${item.type}`); return true },
      pending: async (item) => { calls.push(`pending:${item.type}`) },
    })
    expect(calls).toEqual(['output', 'before:turn.started', 'admit:turn.started',
      'output', 'before:permission.asked', 'admit:permission.asked', 'pending:permission.asked'])
  })

  it('commits assistant text before the engine decides whether the text may stream', async () => {
    const appended: string[] = [], published: string[] = []
    const sink: TurnEventSink = { publish: (type) => { published.push(type) } }
    const admitted: boolean[] = []
    await consumeTurnOutput(stream(event(1, 'assistant.delta', { itemId: 'item-a', text: 'hello' })), 'request-a',
      pipeline(sink, appended), sink, {
        onOutput: () => {}, nativeTurnId: () => 'turn-a', nativeSubmission: () => undefined,
        admit: async (_item, text) => { admitted.push(text.allowed && text.handled); return text.allowed },
        pending: async () => {},
      })
    expect(appended).toEqual(['hello'])
    expect(admitted).toEqual([true])
  })

  it('accepts a non-submission only for the exact session, correlation and unstarted turn', () => {
    const history = { nonSubmission: { nativeSessionId: 'session-a', clientCorrelationId: 'c-1',
      result: { outcome: 'failed' as const } }, events: [], pendingInteractions: [] } satisfies NativeHistory
    expect(observedNonSubmission(history, { native_session_id: 'session-a', active_native_turn_id: null }, 'c-1')).toBe(history.nonSubmission)
    expect(observedNonSubmission(history, { native_session_id: 'session-b', active_native_turn_id: null }, 'c-1')).toBeUndefined()
    expect(observedNonSubmission(history, { native_session_id: 'session-a', active_native_turn_id: null }, 'c-2')).toBeUndefined()
    expect(observedNonSubmission(history, { native_session_id: 'session-a', active_native_turn_id: 'turn-a' }, 'c-1')).toBeUndefined()
  })

  it('matches a message receipt only for the same native session and correlation', () => {
    const receipt = { kind: 'message' as const, nativeSessionId: 'session-a', nativeMessageId: 'm-1', clientCorrelationId: 'c-1' }
    const history = { nativeSubmission: receipt, events: [], pendingInteractions: [] } satisfies NativeHistory
    expect(observedMessageReceipt(history, session, 'c-1')).toBe(receipt)
    expect(observedMessageReceipt(history, session, 'c-2')).toBeUndefined()
    expect(observedMessageReceipt(history, { nativeSessionId: 'session-b' }, 'c-1')).toBeUndefined()
  })
})

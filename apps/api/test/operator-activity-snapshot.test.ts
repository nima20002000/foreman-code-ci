import type pg from 'pg'
import { describe, expect, it } from 'vitest'
import { readOperatorActivitySnapshot } from '../src/modules/conversations/operatorActivitySnapshot.js'

const startedAt = new Date('2026-10-01T00:00:00Z')
describe('persisted Operator activity', () => {
  it('projects exact older active owner, immutable start, latest receipt and response fence independently', async () => {
    // Reads are told apart by their bound values. The conversation id alone is bound four times, in order: the owner row,
    // the latest receipt, the messages and the command activity. The conversation with the active request reads that
    // request's receipt; the unfinished roster (two values) and the activity page (five values) find nothing.
    let conversationReads = 0
    const query = { query: async (_text: string, values: unknown[] = []) => {
      if (values.length === 1) {
        const read = ++conversationReads
        if (read === 1) return { rows: [{ id: 'conversation', revision: '9007199254740993', harness: 'codex',
          native_session_id: 'session', active_request_id: 'A', active_native_turn_id: 'turn-A', cancel_requested: false, turn_state: 'active',
          response_delivery: 'submitted', pending_interaction: { session: { harness: 'codex', providerVersion: 'test', nativeSessionId: 'session' },
            turn: { nativeTurnId: 'turn-A', nativeRequestId: 'question' }, nativeRequestType: 'approval', request: {}, responseOptions: [{ optionId: 'approve', label: 'Approve', semantic: 'approve_once' }] } }] }
        if (read === 2) return { rows: [{ request_id: 'B', sequence: '2', started_at: null, outcome: 'succeeded', native_turn_id: null }] }
        if (read === 3) return { rows: [{ record: { id: 'text', conversationId: 'conversation', requestId: 'A',
          role: 'assistant', content: '', nativeMessageId: 'native-text', nativeMessageComplete: true, revision: '4', sequence: '3' } }] }
        return { rows: [] }
      }
      if (values.length === 2 && values[1] === 'A') return { rows: [{ request_id: 'A', sequence: '1', started_at: startedAt, outcome: null, native_turn_id: 'turn-A' }] }
      if (values.length === 2 || values.length === 5) return { rows: [] }
      throw new Error(`Unexpected statement binding ${values.length} values`)
    } } as unknown as Pick<pg.PoolClient, 'query'>
    const result = await readOperatorActivitySnapshot({} as pg.Pool, query, 'conversation')
    expect(result?.active[0]).toMatchObject({ ref: { requestId: 'A' }, phase: 'waiting', startedAt: startedAt.toISOString() })
    expect(result?.latest).toMatchObject({ requestId: 'B' }); expect(result?.queued).toEqual([])
    expect(result?.pendingInteractions[0]).toMatchObject({ native: { requestId: 'question' }, delivery: 'delivery_pending', answerRecorded: false, providerAcknowledged: false })
    expect(result?.activities[0]).toMatchObject({ kind: 'text', text: '', revision: '4', finality: 'authoritative_final' })
    expect(result?.activities[0]?.native).toEqual({ harness: 'codex', sessionId: 'session', turnId: 'turn-A', itemId: 'native-text' })
  })
})

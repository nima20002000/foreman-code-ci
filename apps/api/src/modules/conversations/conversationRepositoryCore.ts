import type pg from 'pg'
import type { ExecutionResult } from '@foreman-code/contracts'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'
import { recordNativeNonSubmission, type NativeNonSubmission } from './nativeNonSubmission.js'

/** Which engine owns a row of the shared conversation tables. */
export type ConversationKind = 'agent' | 'operator'

/**
 * Journal writes both chat repositories make to the shared conversation tables (operator_conversations and its
 * _turns). Each write is fenced by the conversation's active request; the kind keeps each engine to its own rows.
 */
export class ConversationRepositoryCore<Row extends pg.QueryResultRow> {
  constructor(readonly pool: pg.Pool, protected readonly kind: ConversationKind) {}

  /** This engine's conversation row, locked for the caller's transaction. Deleted rows included. */
  protected async lockRow(query: SqlQuery, id: string): Promise<Row | undefined> {
    return (await query.query<Row>('select * from operator_conversations where id=$1 and kind=$2 for update', [id, this.kind])).rows[0]
  }

  /** A live (not deleted) conversation row, locked for delivery admission. */
  async lockLiveRow(tx: SqlQuery, id: string): Promise<Row | undefined> {
    return (await tx.query<Row>('select * from operator_conversations where id=$1 and kind=$2 and deleted_at is null for update',
      [id, this.kind])).rows[0]
  }

  async markInitialInputOffered(id: string, requestId: string): Promise<void> {
    const changed = await this.pool.query(`update operator_conversation_turns t
      set payload=payload || '{"initialInputOffered":true}'::jsonb
      from operator_conversations c where c.id=t.conversation_id and c.id=$1
        and c.active_request_id=$2 and t.request_id=$2 and c.deleted_at is null`, [id, requestId])
    if (changed.rowCount !== 1) throw new DomainError('CHAT_OWNER_CHANGED', 'The initial native input lost its admitted owner.', 409)
  }

  async initialInputOffered(id: string, requestId: string): Promise<boolean> {
    const row = (await this.pool.query<{ offered: boolean }>(`select
      coalesce((payload->>'initialInputOffered')::boolean,false) as offered
      from operator_conversation_turns where conversation_id=$1 and request_id=$2`, [id, requestId])).rows[0]
    return row?.offered === true
  }

  async requestCancel(id: string, requestId: string, query: SqlQuery = this.pool): Promise<boolean> {
    return (await query.query(`update operator_conversations set cancel_requested=true,turn_state='canceling',revision=revision+1,updated_at=now()
      where id=$1 and active_request_id=$2`, [id, requestId])).rowCount === 1
  }

  recordNonSubmission(id: string, requestId: string, operation: NativeNonSubmission['operation'],
    result: ExecutionResult): Promise<boolean> {
    return recordNativeNonSubmission(this.pool, id, requestId, operation, result)
  }

  protected async bump(id: string, query: SqlQuery = this.pool): Promise<void> {
    await query.query('update operator_conversations set revision=revision+1,updated_at=now() where id=$1', [id])
  }
}

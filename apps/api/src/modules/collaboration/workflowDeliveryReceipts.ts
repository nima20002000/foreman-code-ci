import { canonicalJson, ChatDeliveryReceiptSchema, type ChatDeliveryReceipt } from '@foreman-code/contracts'
import type { SqlTransaction } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'

/** Run receipt updates join the same transaction as the shared delivery journal. */
export async function synchronizeChatDelivery(sql: SqlTransaction, receipt: ChatDeliveryReceipt) {
  const stored = (await sql.query<{ receipt: unknown; owner_admission: string }>(
    'select receipt,owner_admission from chat_delivery_commands where id=$1 for update', [receipt.id])).rows[0]
  if (!stored) return
  const previous = ChatDeliveryReceiptSchema.parse(stored.receipt)
  const identity = (value: ChatDeliveryReceipt) => [value.commandId, value.target,
    value.requestedIntent, value.appliedIntent, value.createdAt]
  if (stored.owner_admission !== 'owner_admitted' || canonicalJson(identity(previous)) !== canonicalJson(identity(receipt))) {
    throw new DomainError('CHAT_OWNER_RECEIPT_CONFLICT', 'The Run receipt does not match its accepted chat delivery.', 409)
  }
  const next = receipt
  if (canonicalJson(previous) === canonicalJson(next)) return
  await sql.query(`update chat_delivery_commands
    set receipt=$2::jsonb,revision=revision+1,updated_at=now() where id=$1`,
  [receipt.id, canonicalJson(next)])
}

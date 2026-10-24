import { omitProperties } from '../../shared/omitProperties.js'
import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { ChatDeliveryReceipt } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'

export const CHAT_PAGE_BYTES = 256 * 1024

export function receiptId(principalId: string, commandId: string): string {
  return `chat:${commandInputHash([principalId, commandId]).slice(7)}`
}

export function effectiveInput(request: { commandId?: string | undefined; [key: string]: unknown }): string {
  const input = omitProperties(request, ['commandId'])
  return commandInputHash(input)
}

export function isTerminalReceipt(receipt: ChatDeliveryReceipt): boolean {
  return ['completed', 'failed', 'canceled'].includes(receipt.state)
}

export function pageLimit(value = 50): number {
  if (!Number.isInteger(value) || value < 1 || value > 100) throw new DomainError('CHAT_PAGE_INVALID', 'Use a page limit between 1 and 100.', 422)
  return value
}

export function encodeCursor(scope: unknown, sequence: number): string {
  return Buffer.from(JSON.stringify({ key: commandInputHash(scope), sequence })).toString('base64url')
}

export function decodeCursor(scope: unknown, cursor?: string): number | undefined {
  if (!cursor) return undefined
  try {
    const value: unknown = JSON.parse(Buffer.from(cursor, 'base64url').toString())
    if (typeof value !== 'object' || value === null || !('key' in value) || value.key !== commandInputHash(scope)
      || !('sequence' in value) || typeof value.sequence !== 'number' || !Number.isSafeInteger(value.sequence) || value.sequence < 0) throw new Error('scope')
    return value.sequence
  } catch (error) {
    throw new DomainError('CHAT_CURSOR_INVALID', 'This cursor does not belong to the selected chat and filter.', 422, undefined, { cause: error })
  }
}

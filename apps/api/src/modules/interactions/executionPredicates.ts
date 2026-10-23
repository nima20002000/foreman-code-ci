import type { DurableInteraction } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'
import { NativeDeliveryError } from '../harnesses/errors.js'

export function isRestartCancellation(error: unknown, signal?: AbortSignal): boolean {
  const reason = signal?.reason
  if (!(reason instanceof DomainError) || reason.code !== 'ENGINE_RESTART') return false
  return error === reason || error instanceof NativeDeliveryError
    && error.cleanup === 'confirmed' && error.cause === reason
}

export function isCredentialAuthorityLost(error: unknown): boolean {
  return error instanceof DomainError && ([401, 403].includes(error.status)
    || error.code === 'WORKER_CREDENTIAL_NOT_RENEWABLE')
}

/** Cold restoration keeps the original session for unanswered, answered and delivered
 * approvals; delivery recovery and checkpoint consumption then settle them without resending. */
export function restorableApproval(interaction: DurableInteraction): boolean {
  return interaction.status !== 'canceled'
}

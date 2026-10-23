import { capabilityDescriptorsOf } from '../harnesses/index.js'
import { isSessionNativeInteraction, type PendingNativeInteraction } from '@foreman-code/contracts'

/** Whether a pending native request belongs to the workflow lane's provider turn. Codex lanes are keyed by the
 * native turn id, Claude lanes by the submitted message id (see `workflowProviderId`). */
export function pendingOnLaneTurn(pending: PendingNativeInteraction, providerId: string | null | undefined): boolean {
  if (isSessionNativeInteraction(pending)) return true
  const turnId = capabilityDescriptorsOf(pending.session).inputIdentity === 'message' ? pending.turn.nativeMessageId : pending.turn.nativeTurnId
  return Boolean(providerId) && turnId === providerId
}

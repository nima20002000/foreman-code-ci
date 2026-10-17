import { commandInputHash } from '@foreman-code/contracts/command-identity-node'
import type { WorkerConversationBinding } from '@foreman-code/contracts/remote-execution-rpc'

/** A replacement session keeps earlier native receipts under their original journal identity. */
export function workerConversationJournalKey(binding: WorkerConversationBinding): string {
  return binding.sessionGeneration
    ? commandInputHash([binding.owner.conversationId, binding.sessionGeneration])
    : binding.owner.conversationId
}

import type {
  AgentIdentity, ChatDeliveryReceipt, ChatSendRequest, DeliveryTarget,
  EngineChatReadback, SendOperatorMessageRequest,
} from '@foreman-code/contracts'
import type { AcceptedChatInput } from '../conversations/nativeChatInput.js'

export interface ChatScope { workspaceId: string; workflowId: string }
/** Private admission pins; public nativeTurnId may later identify the delivered continuation instead. */
export interface DeliveryOwnerBinding {
  agentIdentity?: AgentIdentity
  legacyInputHash?: string
  operatorInput?: SendOperatorMessageRequest
  configurationVersionId?: string
  ownerRequestId?: string
  nativeSessionId?: string
  deliveredNativeSessionId?: string
  nativeTurnId?: string
  inputMessageId?: string
  sessionMode?: 'regular' | 'plan'
  acceptedInput?: AcceptedChatInput
}
export interface DeliveryQualification {
  appliedIntent: ChatDeliveryReceipt['appliedIntent']
  ownerBinding: DeliveryOwnerBinding
}
export interface StoredDelivery {
  principalId: string
  request: ChatSendRequest & { commandId: string }
  receipt: ChatDeliveryReceipt
  inputHash: string
  ownerAdmission: 'prepared' | 'owner_admitted'
  ownerBinding: DeliveryOwnerBinding
  sequence: number
  revision: number
}

/** Exact target reads keep standalone messages and Run-owned provenance in their original shapes. */
export type ChatTargetRead = EngineChatReadback | {
  target: DeliveryTarget
  state: unknown
  receipts: ChatDeliveryReceipt[]
  delivery: { state: EngineChatReadback['state']; capabilities: EngineChatReadback['capabilities']; nativeTurnId?: string }
}

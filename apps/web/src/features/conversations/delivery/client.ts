import {
  ChatSendRequestSchema, ChatStopRequestSchema, ChatQueueCancelRequestSchema, ChatDeliveryReceiptSchema,
  ChatControlReceiptSchema, EngineChatReadbackSchema,
  type ChatSendRequest, type ChatStopRequest, type ChatQueueCancelRequest, type DeliveryTarget,
} from '@foreman-code/contracts'
import {
  ChatDeliveryInputsReadbackSchema, ChatDeliveryReadbackSchema, ChatDeliveryReceiptsReadbackSchema,
  type ChatDeliveryInputPage, type ChatDeliveryReadback,
} from '@foreman-code/contracts/agent-chat'
import { apiClient, ApiError, type RequestOptions } from '../../../shared/api/client'
import { sameDeliveryTarget } from '../../workflow-chat/draft'

export type RetainedInputPage = ChatDeliveryInputPage
export type RetainedInput = RetainedInputPage['items'][number]
export type RetainedInputSelection = { cursor?: string; limit?: number; receiptId?: string; bodyCursor?: string }
export type DeliveryReadback = ChatDeliveryReadback

export function chatDeliveryRoot(target: DeliveryTarget) {
  return target.kind === 'operator_conversation'
    ? `/api/operator/conversations/${encodeURIComponent(target.conversationId)}/deliveries`
    : `/api/workspaces/${encodeURIComponent(target.agent.workspaceId)}/agent-chat/deliveries`
}
function verify<T extends { target: DeliveryTarget }>(target: DeliveryTarget, response: T): T {
  if (!sameDeliveryTarget(target, response.target)) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Delivery returned a different target.' }, 409)
  return response
}
export const chatDeliveryClient = {
  async read(target: DeliveryTarget, options?: RequestOptions) {
    return verify(target, await apiClient.request(`${chatDeliveryRoot(target)}/read`, ChatDeliveryReadbackSchema,
      { ...options, method: 'POST', body: { target, limit: 50 } }))
  },
  async receipt(target: DeliveryTarget, commandId: string, options?: RequestOptions) {
    return verify(target, await apiClient.request(`${chatDeliveryRoot(target)}/read`, ChatDeliveryReceiptsReadbackSchema,
      { ...options, method: 'POST', body: { target, commandId } }))
  },
  async receiptById(target: DeliveryTarget, receiptId: string, options?: RequestOptions) {
    const result = verify(target, await apiClient.request(`${chatDeliveryRoot(target)}/read`, ChatDeliveryReceiptsReadbackSchema,
      { ...options, method: 'POST', body: { target, receiptId } }))
    if (result.receipts.some(receipt => receipt.id !== receiptId || !sameDeliveryTarget(receipt.target, target))) {
      throw new ApiError({ code: 'INVALID_RESPONSE', message: 'The requested delivery receipt did not match this target.' }, 409)
    }
    return result
  },
  async inputs(target: DeliveryTarget, deliveryInputs: RetainedInputSelection = {}, options?: RequestOptions) {
    const page = verify(target, await apiClient.request(`${chatDeliveryRoot(target)}/read`, ChatDeliveryInputsReadbackSchema,
      { ...options, method: 'POST', body: { target, deliveryInputs } })).deliveryInputs
    if (page.items.some(item => !sameDeliveryTarget(item.target, target))) {
      throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Original inputs returned a different target.' }, 409)
    }
    return page
  },
  async page(target: DeliveryTarget, cursor: string, options?: RequestOptions) {
    return verify(target, await apiClient.request(`${chatDeliveryRoot(target)}/read`, EngineChatReadbackSchema,
      { ...options, method: 'POST', body: { target, cursor, limit: 50 } }))
  },
  async send(request: ChatSendRequest, options?: RequestOptions) {
    return verify(request.target, await apiClient.request(`${chatDeliveryRoot(request.target)}/send`, ChatDeliveryReceiptSchema,
      { ...options, method: 'POST', body: ChatSendRequestSchema.parse(request) }))
  },
  async stop(request: ChatStopRequest, options?: RequestOptions) {
    return verify(request.target, await apiClient.request(`${chatDeliveryRoot(request.target)}/stop`, ChatControlReceiptSchema,
      { ...options, method: 'POST', body: ChatStopRequestSchema.parse(request) }))
  },
  async cancel(request: ChatQueueCancelRequest, options?: RequestOptions) {
    return verify(request.target, await apiClient.request(`${chatDeliveryRoot(request.target)}/cancel`, ChatControlReceiptSchema,
      { ...options, method: 'POST', body: ChatQueueCancelRequestSchema.parse(request) }))
  },
}

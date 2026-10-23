import {
  ChatDeliveryReceiptSchema, WorkflowChatBodySchema, WorkflowChatDeliveryPageSchema, WorkflowChatPageSchema,
  WorkflowChatPostRequestSchema, WorkflowChatPostResponseSchema,
  type WorkflowChatDeliveryPage, type WorkflowChatPostRequest,
} from '@foreman-code/contracts'
import { apiClient, type RequestOptions } from '../../shared/api/client'

export type { WorkflowChatEvent, WorkflowChatPage } from '@foreman-code/contracts'
export type WorkflowDeliveryPage = WorkflowChatDeliveryPage
export type WorkflowChatScope = Pick<WorkflowChatPostRequest, 'workspaceId' | 'workflowId'>
export type WorkflowChatRead = { cursor?: string; limit?: number; runId?: string; postId?: string; commandId?: string }

export const workflowChatRoot = ({ workspaceId, workflowId }: WorkflowChatScope) =>
  `/api/workspaces/${encodeURIComponent(workspaceId)}/workflows/${encodeURIComponent(workflowId)}/chat`
function query(input: Record<string, string | number | undefined>) {
  const params = new URLSearchParams()
  for (const [key, value] of Object.entries(input)) if (value !== undefined) params.set(key, String(value))
  return params.size ? `?${params}` : ''
}

export const workflowChatClient = {
  read(scope: WorkflowChatScope, selection: WorkflowChatRead = {}, options?: RequestOptions) {
    return apiClient.request(`${workflowChatRoot(scope)}${query(selection)}`, WorkflowChatPageSchema, options)
  },
  deliveries(scope: WorkflowChatScope, selection: WorkflowChatRead & { receiptId?: string } = {}, options?: RequestOptions) {
    return apiClient.request(`${workflowChatRoot(scope)}/deliveries${query(selection)}`, WorkflowChatDeliveryPageSchema, options)
  },
  body(scope: WorkflowChatScope, postId: string, bodyCursor?: string, options?: RequestOptions) {
    return apiClient.request(`${workflowChatRoot(scope)}${query({ mode: 'body', postId, bodyCursor })}`,
      WorkflowChatBodySchema, options)
  },
  post(request: WorkflowChatPostRequest, options?: RequestOptions) {
    return apiClient.request(`${workflowChatRoot(request)}/posts`, WorkflowChatPostResponseSchema,
      { ...options, method: 'POST', body: WorkflowChatPostRequestSchema.parse(request) })
  },
  cancel(scope: WorkflowChatScope, receiptId: string, commandId: string, options?: RequestOptions) {
    return apiClient.request(`${workflowChatRoot(scope)}/deliveries/${encodeURIComponent(receiptId)}/cancel`,
      ChatDeliveryReceiptSchema, { ...options, method: 'POST', body: { commandId } })
  },
}

export type WorkflowChatClient = typeof workflowChatClient

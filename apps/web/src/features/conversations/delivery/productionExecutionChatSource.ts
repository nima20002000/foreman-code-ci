import { connectChatStream } from '../../../shared/api/chatStreamEvents'
import { EngineChatMessageSchema, WorkflowExecutionChatMessageRequestSchema,
  WorkflowExecutionChatChangeSchema } from '@foreman-code/contracts'
import { apiClient, ApiError } from '../../../shared/api/client'
import { eventStreamsAvailable, openEventStreamScope } from '../../../shared/api/eventStream'
import { sameDeliveryTarget } from '../../workflow-chat'
import type { ExecutionChatSource, ExecutionChatTarget } from './executionChatSource'

function path(target: ExecutionChatTarget) {
  return `/api/workspaces/${encodeURIComponent(target.agent.workspaceId)}`
    + `/workflows/${encodeURIComponent(target.agent.workflowId)}/execution-chat`
}

export const productionExecutionChatSource: ExecutionChatSource = {
  subscribe(target, receive, options) {
    if (!eventStreamsAvailable()) return () => {}
    const stream = openEventStreamScope(options.signal)
    if (!stream) return () => {}
    let cursor: string | undefined
    connectChatStream(stream, `${path(target)}/events?${new URLSearchParams({ target: JSON.stringify(target) })}`, {
      schema: WorkflowExecutionChatChangeSchema, events: ['changed'],
      receive: change => {
        if (!sameDeliveryTarget(target, change.target)) throw new Error('Chat stream target changed')
        if (cursor !== change.cursor) { cursor = change.cursor; receive(change) }
      },
      invalid: error => options.error(error instanceof Error ? error : new Error('Invalid chat stream event')),
      handlers: {
        open: () => options.reconnect(),
        error: () => options.error(new Error('Chat stream disconnected')),
        unavailable: () => {
          stream.close()
          options.error(new ApiError({ code: 'ACCESS_DENIED', message: 'This Run chat is unavailable.' }, 403))
        },
      },
    })
    return stream.close
  },
  readMessage(target, message, options) {
    return apiClient.request(`${path(target)}/message`, EngineChatMessageSchema, { ...options, method: 'POST',
      body: WorkflowExecutionChatMessageRequestSchema.parse({ target, messageId: message.id }) })
  },
}

import type { FastifyInstance } from 'fastify'
import { z } from 'zod'
import { WORKFLOW_EXECUTION_CHAT_ROUTE, WorkflowExecutionChatTargetSchema,
  type WorkflowExecutionChatChange } from '@foreman-code/contracts'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { WorkflowExecutionChatService } from '../modules/collaboration/workflowChatService.js'
import { createSseWriter } from './sseWriter.js'

const querySchema = z.object({ target: z.string().transform((value, context) => {
  try { return JSON.parse(value) as unknown }
  catch {
    context.addIssue({ code: 'custom', message: 'Provide the exact chat target as JSON.' })
    return z.NEVER
  }
}).pipe(WorkflowExecutionChatTargetSchema) }).strict()

export function registerWorkflowExecutionChatEvents(app: FastifyInstance, service: WorkflowExecutionChatService) {
  const streams = new Map<() => void, string>()
  app.addHook('preClose', async () => { for (const close of streams.keys()) close() })
  app.get<{ Params: { workspaceId: string; workflowId: string }; Querystring: unknown }>(
    `${WORKFLOW_EXECUTION_CHAT_ROUTE}/events`, async (request, reply) => {
      const { target } = querySchema.parse(request.query)
      if (target.agent.workspaceId !== request.params.workspaceId || target.agent.workflowId !== request.params.workflowId) {
        throw new DomainError('RESOURCE_ID_MISMATCH', 'The chat target must match its workflow URL.', 400)
      }
      let principal = requirePrincipal(request)
      if (!request.reauthorizeOperator) throw new DomainError('AUTH_REQUIRED', 'Stream reauthorization is unavailable.', 401)
      if (streams.size >= 64 || [...streams.values()].filter(id => id === principal.id).length >= 8) {
        throw new DomainError('STREAM_LIMIT', 'Close an inactive chat stream and try again.', 429)
      }
      const first = await service.changes(principal, target)
      let closed = false
      let polling = false
      let cursor: string | undefined
      const close = () => {
        if (closed) return
        closed = true
        clearInterval(timer)
        streams.delete(close)
        writer.close()
        if (!reply.raw.writableEnded) reply.raw.end()
      }
      const writer = createSseWriter(reply.raw, () => !closed, close)
      const publish = (change: WorkflowExecutionChatChange) => {
        if (change.cursor === cursor) { writer.write(': current\n\n'); return }
        cursor = change.cursor
        writer.write(`id: ${cursor}\nevent: changed\ndata: ${JSON.stringify(change)}\n\n`)
      }
      streams.set(close, principal.id)
      reply.raw.once('close', close)
      reply.raw.once('error', close)
      reply.hijack()
      reply.raw.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache, no-transform',
        connection: 'keep-alive', 'x-accel-buffering': 'no' })
      const poll = async () => {
        if (closed || polling) return
        polling = true
        try {
          principal = await request.reauthorizeOperator!()
          const change = await service.changes(principal, target)
          if (!closed) publish(change)
        } catch (error) {
          app.log.warn({ err: error }, 'Execution chat stream stopped')
          if (!closed) writer.write('event: unavailable\ndata: {}\n\n')
          close()
        } finally { polling = false }
      }
      const timer = setInterval(() => { void poll() }, 2000)
      timer.unref()
      publish(first)
    })
}

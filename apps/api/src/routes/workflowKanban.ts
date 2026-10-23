import type { FastifyInstance } from 'fastify'
import { WORKFLOW_KANBAN_LAYOUT_ROUTE } from '@foreman-code/contracts'
import { requirePrincipal } from '../modules/access/http.js'
import { DomainError } from '../modules/errors.js'
import type { WorkflowKanbanLayoutService } from '../modules/workflows/kanbanLayout.js'

interface Scope { workspaceId: string; workflowId: string }

/** The same service backs workflow_kanban_layout_get/set in Operator MCP. */
export function registerWorkflowKanbanRoutes(app: FastifyInstance, service: WorkflowKanbanLayoutService): void {
  app.get<{ Params: Scope }>(WORKFLOW_KANBAN_LAYOUT_ROUTE, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    return service.get(requirePrincipal(request), request.params)
  })
  app.put<{ Params: Scope; Body: unknown }>(WORKFLOW_KANBAN_LAYOUT_ROUTE, async (request, reply) => {
    reply.header('cache-control', 'no-store')
    const body = (request.body && typeof request.body === 'object' ? request.body : {}) as Record<string, unknown>
    if (body.workspaceId !== undefined && body.workspaceId !== request.params.workspaceId
      || body.workflowId !== undefined && body.workflowId !== request.params.workflowId) {
      throw new DomainError('RESOURCE_ID_MISMATCH', 'The Kanban layout must match its URL scope.', 400)
    }
    return service.set(requirePrincipal(request), 'http', { ...body, ...request.params })
  })
}

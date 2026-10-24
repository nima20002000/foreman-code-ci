import type pg from 'pg'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { readChatPrincipal, readLiveManagementPrincipal, requireAuthorization } from '../access/index.js'
import { DomainError } from '../errors.js'
import { createChatDeliveryFeature, type ChatDeliveryAccess } from '../workflow-chat/index.js'
import type { AgentChatService, ConversationFeatureBinder, OperatorChatService } from '../conversations/index.js'
import type { WorkflowExecutionChatService } from './workflowChatService.js'
import { authorizeWorkflowChat, withWorkflowChatRead } from './workflowChatRead.js'
import { readWorkflowChatIdentity } from './workflowChatIdentity.js'
import { asWorkflowChatTarget } from './workflowControlRecords.js'

export function productionChatDeliveryAccess(pool: pg.Pool): ChatDeliveryAccess {
  return {
    restore: id => readChatPrincipal(pool, id),
    async resolve(principal, action, scope, transaction) {
      const sql: SqlQuery = transaction ?? pool
      const live = await readChatPrincipal(sql, principal.id)
      requireAuthorization(live, action, scope)
      return { principal: live }
    },
  }
}

export function createProductionChatDelivery(input: {
  pool: pg.Pool; agent: AgentChatService; operator: OperatorChatService
  execution: WorkflowExecutionChatService; bindConversationScope: ConversationFeatureBinder
}) {
  const { pool, execution, agent } = input
  return createChatDeliveryFeature({ ...input, access: productionChatDeliveryAccess(pool),
    targets: { async resolve(principal, workspaceId, query) {
      if (query.runId) {
        const selected = await execution.resolve(principal, { workspaceId, workflowId: query.workflowId,
          workflowNodeId: query.workflowNodeId, runId: query.runId })
        if (selected.kind !== 'selected') throw new DomainError(
          'CHAT_TARGET_SELECTION_REQUIRED', 'Choose the exact Run chat target before sending.', 409)
        if (selected.agent.agentId !== query.agentId) throw new DomainError(
          'CHAT_TARGET_CHANGED', 'The selected Agent does not match this Run node.', 409)
        if (selected.state === 'idle' && selected.target.kind === 'workflow_execution') return {
          kind: 'historical_execution', selection: { workspaceId, workflowId: query.workflowId,
            workflowNodeId: query.workflowNodeId, runId: query.runId, executionId: selected.target.execution.executionId },
        }
        return selected.target
      }
      const read = await agent.read(principal, workspaceId, query)
      if (!read.deliveryTarget) throw new DomainError('CHAT_TARGET_UNAVAILABLE', 'Read the selected Agent before sending.', 409)
      return read.deliveryTarget
    } },
    qualifyExecutionLocked: (_tx, principal, request) => execution.qualify(principal, request),
    async authorizeExecutionTarget(principal, target, action, sql) {
      if (sql) {
        authorizeWorkflowChat(await readLiveManagementPrincipal(sql, principal.id), target, `agent_chat:${action}`)
        await readWorkflowChatIdentity(sql, target)
      } else await withWorkflowChatRead(pool, principal, asWorkflowChatTarget(target), `agent_chat:${action}`,
        query => readWorkflowChatIdentity(query, target))
    },
  })
}

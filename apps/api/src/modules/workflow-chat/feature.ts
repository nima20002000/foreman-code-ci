import type pg from 'pg'
import type { ChatSendRequest, DeliveryTarget } from '@foreman-code/contracts'
import type { ManagementAction, ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ExecutionChatPort } from '../collaboration/index.js'
import type { TransactionSql } from '../../infrastructure/transaction.js'
import type { AgentChatService } from '../conversations/index.js'
import type { ConversationFeatureBinder } from '../conversations/index.js'
import type { OperatorChatService } from '../conversations/index.js'
import { DomainError } from '../errors.js'
import { componentLogger } from '../diagnostics/index.js'
import { ChatDeliveryRouter, type ChatTargetAuthority } from './delivery.js'
import { PostgresChatDeliveryRepository } from './deliveryRepository.js'
import { ChatDeliveryBridge, type ChatTargetResolver } from './deliveryBridge.js'
import type { ChatScope, DeliveryQualification } from './model.js'

export interface ChatDeliveryAccess {
  resolve(principal: ManagementPrincipal, action: ManagementAction, scope: ChatScope | undefined,
    tx?: TransactionSql): Promise<{ principal: ManagementPrincipal }>
  restore(principalId: string): Promise<ManagementPrincipal>
}
export interface ChatDeliveryFeatureDependencies {
  pool: pg.Pool
  agent: AgentChatService
  operator: OperatorChatService
  access: ChatDeliveryAccess
  execution: ExecutionChatPort
  qualifyExecutionLocked(tx: TransactionSql, principal: ManagementPrincipal,
    request: ChatSendRequest): Promise<DeliveryQualification>
  targets: ChatTargetResolver
  authorizeExecutionTarget(principal: ManagementPrincipal, target: Exclude<DeliveryTarget,
    { kind: 'agent_conversation' | 'operator_conversation' }>, action: 'read' | 'write' | 'cancel', tx?: TransactionSql): Promise<void>
  bindConversationScope: ConversationFeatureBinder
}

export function createChatDeliveryFeature(dependencies: ChatDeliveryFeatureDependencies) {
  const { pool, access } = dependencies
  const repository = new PostgresChatDeliveryRepository(pool)
  const agent = dependencies.agent.createDeliveryOwner(repository)
  const operator = dependencies.operator.createDeliveryOwner(repository)
  dependencies.agent.installFeatureContextBinder(dependencies.bindConversationScope)
  const authorizeTarget = async (principal: ManagementPrincipal, target: DeliveryTarget,
    action: 'read' | 'write' | 'cancel', tx?: TransactionSql) => {
    const scope = target.kind === 'operator_conversation' ? undefined : target.agent
    const name: ManagementAction = target.kind === 'operator_conversation' ? `operator_chat:${action}` : `agent_chat:${action}`
    const actor = await access.resolve(principal, name, scope, tx)
    if (actor.principal.id !== principal.id) throw new DomainError('CHAT_PRINCIPAL_CHANGED', 'The authenticated chat actor changed.', 403)
    if (target.kind === 'agent_conversation') await agent.hooks.authenticate(principal, target, action, tx)
    else if (target.kind === 'operator_conversation') await operator.hooks.authenticate(principal, target, action, tx)
    else await dependencies.authorizeExecutionTarget(principal, target, action, tx)
    return principal
  }
  const targetAuthority: ChatTargetAuthority = {
    authenticate: (principal, target, action) => authorizeTarget(principal, target, action),
    authorizeLocked: async (tx, principal, target, action) => { await authorizeTarget(principal, target, action, tx) },
    qualifyLocked: (tx, principal, request) => request.target.kind === 'agent_conversation'
      ? agent.qualifyLocked(tx, principal, request)
      : request.target.kind === 'operator_conversation' ? operator.qualifyLocked(tx, principal, request)
        : dependencies.qualifyExecutionLocked(tx, principal, request),
    restorePrincipal: id => access.restore(id),
  }
  const router = new ChatDeliveryRouter(repository, targetAuthority, dependencies.execution, agent, operator)
  const bridge = new ChatDeliveryBridge(router, dependencies.agent, dependencies.operator, dependencies.targets)
  dependencies.agent.installDeliveryBridge(bridge)
  dependencies.operator.installDeliveryBridge(bridge)
  return { repository, router, bridge, targetAuthority, start: () => startPendingDrain(router) }
}

function startPendingDrain(router: ChatDeliveryRouter): () => void {
  let closed = false
  let timer: ReturnType<typeof setTimeout> | undefined
  const drain = async () => {
    try { await router.drainPrepared() }
    catch (error) { componentLogger('engine').warn({ err: error }, 'Chat pending drain will retry retained work') }
    finally { if (!closed) timer = setTimeout(() => { void drain() }, 250) }
  }
  timer = setTimeout(() => { void drain() }, 0)
  return () => { closed = true; clearTimeout(timer) }
}

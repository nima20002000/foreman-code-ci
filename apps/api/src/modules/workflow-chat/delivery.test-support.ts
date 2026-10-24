import { randomUUID } from 'node:crypto'
import type { ChatSendRequest, DeliveryTarget, EngineChatReadback, ChatControlReceipt } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { ExecutionChatPort } from '../collaboration/index.js'
import { withTransaction } from '../../infrastructure/transaction.js'
import { DomainError } from '../errors.js'
import { ChatDeliveryRouter, type ChatTargetAuthority } from './delivery.js'
import { PostgresChatDeliveryRepository } from './deliveryRepository.js'
import { migratedDatabase } from '../../../test/helpers/migratedDatabase.js'

export const caller: ManagementPrincipal = { id: 'user', name: 'User', audience: 'user', revokedAt: null,
  expiresAt: '9999-12-31T23:59:59.999Z', grants: [{ actions: ['agent_chat:read', 'agent_chat:write', 'agent_chat:cancel'],
    scope: { workspaceIds: ['workspace'], workflowIds: ['workflow'] } }] }
export const scope = { workspaceId: 'workspace', workflowId: 'workflow' }
export const target: Extract<DeliveryTarget, { kind: 'workflow_execution' }> = { kind: 'workflow_execution', agent: { ...scope, workflowNodeId: 'node', agentId: 'agent' },
  execution: { runId: 'run', workflowVersionId: 'version', executionId: 'execution', activationId: 'activation', attempt: 1 } }
const qualification = { appliedIntent: 'next_turn' as const, ownerBinding: { configurationVersionId: 'configuration' } }

export async function deliveryFixture() {
  const database = await migratedDatabase()
  const { pool } = database
  await pool.query('create table fake_native_owner(command_id text primary key, receipt_id text not null)')
  const repository = new PostgresChatDeliveryRepository(pool)
  let mutableTargetValid = true, authorized = true
  let crashBeforeAdoption = false, crashAfterNative = false, nativeSubmissions = 0
  const check = (principal: ManagementPrincipal, selected: { workspaceId: string; workflowId: string }) => {
    if (!authorized || principal.id !== caller.id || selected.workspaceId !== scope.workspaceId
      || ![scope.workflowId, 'other-workflow'].includes(selected.workflowId)) {
      throw new DomainError('FORBIDDEN', 'The selected workflow is unavailable.', 403)
    }
  }
  const targetAuthority: ChatTargetAuthority = {
    authenticate: async (principal, selected) => { check(principal, selected.kind === 'operator_conversation' ? scope : selected.agent); return principal },
    authorizeLocked: async (_tx, principal, selected) => { check(principal, selected.kind === 'operator_conversation' ? scope : selected.agent) },
    qualifyLocked: async () => {
      if (!mutableTargetValid) throw new DomainError('TARGET_SETTLED', 'The exact target settled.', 409)
      return qualification
    },
    restorePrincipal: async id => { if (id !== caller.id) throw new DomainError('FORBIDDEN', 'Unknown principal.', 403); return caller },
  }
  const owner: ExecutionChatPort = {
    deliver: async (principal, request) => {
      if (!request.commandId) throw new Error('Expected durable command ID')
      const input: ChatSendRequest & { commandId: string } = { ...request, commandId: request.commandId }
      if (crashBeforeAdoption) throw new Error('Process stopped before owner adoption')
      const admission = await withTransaction(pool, tx => repository.adoptPreparedLocked(tx, principal.id, input, async command => {
        await tx.query('insert into fake_native_owner(command_id,receipt_id) values($1,$2)', [input.commandId, command.receipt.id])
      }))
      if (!admission.adopted) return admission.command.receipt
      nativeSubmissions++
      if (crashAfterNative) throw new Error('Native accepted, response lost')
      await withTransaction(pool, tx => repository.bindNativeSessionLocked(tx, admission.command.receipt.id, `session:${input.commandId}`))
      await repository.update({ ...admission.command.receipt, state: 'accepted', nativeTurnId: `native:${input.commandId}`,
        updatedAt: new Date().toISOString() })
      return (await repository.byReceipt(admission.command.receipt.id))!.receipt
    },
    read: async (_principal, input): Promise<EngineChatReadback> => ({ target: input.target, state: 'idle',
      capabilities: { steer: 'unavailable', queue: true, interruptAndSend: false }, messages: [],
      receipts: (await repository.targetSnapshot(input.target, undefined, 100)).rows.map(row => row.receipt),
      nextCursor: null, hasMore: false, revision: await repository.targetRevision(input.target) }),
    stop: async (_principal, input): Promise<ChatControlReceipt> => ({ commandId: input.commandId ?? randomUUID(), target: input.target,
      operation: input.scope === 'active_turn' ? 'stop_active' : 'stop_active_and_queued', state: 'completed', affectedReceiptIds: [], replayed: false }),
    cancel: async (_principal, input): Promise<ChatControlReceipt> => ({ commandId: input.commandId ?? randomUUID(), target: input.target,
      operation: input.selection.kind === 'one' ? 'cancel_one' : 'cancel_all_queued', state: 'completed', affectedReceiptIds: [], replayed: false }),
  }
  const delivery = new ChatDeliveryRouter(repository, targetAuthority, owner, owner, owner)
  return { pool, repository, delivery, owner, targetAuthority,
    nativeSubmissions: () => nativeSubmissions,
    change: (values: { targetValid?: boolean; authorized?: boolean; beforeAdoption?: boolean; afterNative?: boolean }) => {
      mutableTargetValid = values.targetValid ?? mutableTargetValid; authorized = values.authorized ?? authorized
      crashBeforeAdoption = values.beforeAdoption ?? crashBeforeAdoption; crashAfterNative = values.afterNative ?? crashAfterNative
    },
    close: () => database.close(),
  }
}

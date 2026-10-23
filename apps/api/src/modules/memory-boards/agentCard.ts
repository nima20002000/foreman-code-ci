import { randomUUID } from 'node:crypto'
import { MemoryCardSchema, type AgentSubject, type LogicalWorkRef } from '@foreman-code/contracts'
import { assertGraphTransaction, type GraphTransactionSql } from '../run-graph/connection.js'
import type { MemoryBoardAuthority } from './types.js'
import { nodeKey, same, workKey } from './identity.js'
import { agentCard, bindingsFor, cardByTitle, ensureBoard, lockIdentity, saveBinding, saveCard } from './repository.js'
import { checkCapacity } from './mutations.js'
import { validateCardState } from './work.js'

/** Runs inside the launch transaction, before its prompt snapshot is taken. */
export async function ensureAgentCard(tx: GraphTransactionSql, authority: MemoryBoardAuthority,
  input: { subject: Extract<AgentSubject, { kind: 'execution' }>; work: LogicalWorkRef; title: string }, now: string): Promise<void> {
  assertGraphTransaction(tx)
  const { agent, execution } = input.subject
  await authority.lifecycle(tx, agent, input.work, execution.executionId)
  await lockIdentity(tx, `work:${workKey(input.work)}`)
  await lockIdentity(tx, `node:${nodeKey(agent)}`)
  const row = await ensureBoard(tx, { kind: 'workflow', workspaceId: agent.workspaceId, workflowId: agent.workflowId })
  const before = await agentCard(tx, row.board.id, agent)
  let title = before?.title ?? input.title.slice(0, 240)
  if (!before && await cardByTitle(tx, row.board.id, title)) {
    const suffix = ` (${agent.workflowNodeId.slice(-8)})`
    title = input.title.slice(0, 240 - suffix.length) + suffix
  }
  const next = MemoryCardSchema.parse(before ? { ...before, status: 'doing', completionKind: null,
    reason: before.status === 'doing' ? before.reason : 'Working again' } : {
    id: randomUUID(), boardId: row.board.id, title, body: '', status: 'doing', completionKind: null,
    reason: null, assignee: { workspaceId: agent.workspaceId, workflowId: agent.workflowId,
      workflowNodeId: agent.workflowNodeId, agentId: agent.agentId }, linkedNodes: [], revision: 0, createdAt: now, updatedAt: now,
  })
  validateCardState(next, before)
  if (!before || before.status !== 'doing') await saveCard(tx, row, before, next, {
    actor: { kind: 'engine', id: agent.agentId, displayName: agent.displayName }, now,
    sourceEventKey: `agent-card:${execution.executionId}:launch`, provenance: { work: input.work, execution },
  })
  const bindings = before ? await bindingsFor(tx, before.id) : []
  // A fresh execution reopens this Agent's work record; old failures remain in its history.
  for (const binding of bindings) if (!same(binding.work, input.work) && !binding.resolution
    && ['failed', 'canceled'].includes(binding.state)) {
    await saveBinding(tx, row.board.id, { ...binding, revision: binding.revision + 1,
      resolution: { kind: 'reopened', commandId: `agent-card:${execution.executionId}:launch`, reason: 'Working again', resolvedAt: now } })
  }
  const current = bindings.find(binding => same(binding.work, input.work))
  await saveBinding(tx, row.board.id, current
    ? { ...current, state: 'running', currentExecutionId: execution.executionId, reason: null, revision: current.revision + 1 }
    : { id: randomUUID(), cardId: next.id, node: next.assignee!, work: input.work, state: 'running',
      currentExecutionId: execution.executionId, reason: null, revision: 1 })
  checkCapacity([row])
}

import type { BoardLifecycleFact } from '@foreman-code/contracts'
import { parseWorkHandoffResult, WorkReturnSchema } from '@foreman-code/contracts/wave25'
import { memoryExecution } from '../collaboration/memoryBoardAuthority.js'
import type { MemoryBoardPort } from '../collaboration/ports.js'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { selectedWorkHandoffRoutes } from './workHandoffRouting.js'

type Settlement = Pick<BoardLifecycleFact, 'phase' | 'reason' | 'outstandingRequestIds'>
const waiting: Settlement = { phase: 'waiting_children', reason: null, outstandingRequestIds: [] }

async function settlement(tx: GraphTransactionSql, executionId: string, visited: Set<string>): Promise<Settlement> {
  if (visited.has(executionId)) return waiting
  visited.add(executionId)
  const saved = await memoryExecution(tx, executionId)
  const result = saved.execution.result
  if (result?.outcome === 'failed' || result?.outcome === 'canceled') {
    return { phase: 'blocked', reason: result.error?.message ?? 'Required work was canceled.', outstandingRequestIds: [] }
  }
  if (!saved.accepted || result?.outcome !== 'succeeded') return waiting
  const output = parseWorkHandoffResult(result)
  if (output.data.remainingFindings.length) {
    return { phase: 'blocked', reason: output.data.remainingFindings.join('\n'), outstandingRequestIds: [] }
  }
  if (output.routing.kind === 'return') {
    const returned = await tx.query('select return_id from run_work_returns where run_id=$1 and source_execution_id=$2',
      [saved.execution.runId, executionId])
    if (!returned.rowCount) return waiting
  }
  const routes = selectedWorkHandoffRoutes(saved.version.definition, saved.node.id, output)
  const requests = (await tx.query<{ request_id: string; relationship_id: string;
    returned: unknown; execution_id: string | null }>(`select q.request_id,q.relationship_id,t.record as returned,x.execution_id
    from run_work_requests q left join run_work_returns t on t.run_id=q.run_id and t.request_id=q.request_id
    left join lateral (select e.execution_id from run_repeat_executions e
      where e.run_id=q.run_id and e.work_activation_id=q.destination_activation_id
      order by e.technical_attempt desc limit 1) x on true
    where q.run_id=$1 and q.requester_execution_id=$2 order by q.request_id`,
  [saved.execution.runId, executionId])).rows
  if (routes.some(id => !requests.some(request => request.relationship_id === id))) return waiting
  const pending: string[] = []
  for (const request of requests) {
    if (request.returned) {
      const returned = WorkReturnSchema.parse(request.returned)
      if (returned.outcome === 'accepted' && !returned.remainingFindings.length) continue
      return { phase: 'blocked', reason: returned.remainingFindings.join('\n') || 'Required work needs changes.',
        outstandingRequestIds: [request.request_id] }
    }
    const child = request.execution_id ? await settlement(tx, request.execution_id, new Set(visited)) : waiting
    if (child.phase === 'blocked') return { ...child, outstandingRequestIds: [request.request_id] }
    if (child.phase !== 'accepted') pending.push(request.request_id)
  }
  return { phase: pending.length ? 'waiting_children' : 'accepted', reason: null, outstandingRequestIds: pending }
}

/** Only the affected request ancestry is read; no card history or native transcript is scanned. */
export async function reconcileMemoryHandoffsLocked(tx: GraphTransactionSql, service: MemoryBoardPort,
  executionId: string, sourceEventKey: string): Promise<void> {
  const source = await memoryExecution(tx, executionId)
  if (source.work.kind !== 'activation' || !source.version.definition.handoffs) return
  const parents = (await tx.query<{ execution_id: string }>(`with recursive parents(activation_id,execution_id) as (
    select q.requester_activation_id,q.requester_execution_id from run_work_requests q
      where q.run_id=$1 and q.destination_activation_id=$2
    union select q.requester_activation_id,q.requester_execution_id from run_work_requests q
      join parents p on p.activation_id=q.destination_activation_id where q.run_id=$1
    ) select distinct execution_id from parents`, [source.work.runId, source.work.activationId])).rows
  for (const id of [executionId, ...parents.map(parent => parent.execution_id)]) {
    const saved = id === executionId ? source : await memoryExecution(tx, id)
    // Native and admission callbacks own this execution until its result is accepted.
    if (!saved.accepted) continue
    const state = await settlement(tx, id, new Set())
    await service.applyLifecycleLocked(tx, { agent: saved.subject.agent, execution: saved.subject.execution,
      work: saved.work, sourceEventKey: `${sourceEventKey}:requests:${id}`, ...state })
  }
}

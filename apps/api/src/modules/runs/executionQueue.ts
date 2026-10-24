import type { SqlQuery } from '../../infrastructure/transaction.js'
import type { ExecutionQueueEntry, ExecutionQueueReason, HarnessExecution } from '@foreman-code/contracts'

export type ExecutionQueueIdentity = Pick<HarnessExecution, 'id' | 'runId' | 'workflowNodeId'>
type WaitReason = Omit<Extract<ExecutionQueueReason, { kind: 'host_capacity' }>, 'since'>
  | Omit<Extract<ExecutionQueueReason, { kind: 'workflow_parallelism' }>, 'since'>

// These waits belong to the process-local gates, not the immutable graph journal.
const waiting = new Map<string, { identity: ExecutionQueueIdentity; reason: ExecutionQueueReason }>()

export async function withExecutionQueueReason<T>(identity: ExecutionQueueIdentity | undefined,
  reason: WaitReason, work: () => Promise<T>): Promise<T> {
  if (!identity) return work()
  const wait = { identity, reason: { ...reason, since: new Date().toISOString() } }
  waiting.set(identity.id, wait)
  try {
    return await work()
  } finally {
    if (waiting.get(identity.id) === wait) waiting.delete(identity.id)
  }
}

export function readExecutionQueueReason(execution: HarnessExecution): ExecutionQueueReason | undefined {
  const wait = waiting.get(execution.id)
  if (!wait || execution.state === 'completed' || wait.identity.runId !== execution.runId) return undefined
  return wait.reason
}

export function readRunExecutionQueue(runId: string): ExecutionQueueEntry[] {
  const entries: ExecutionQueueEntry[] = []
  for (const { identity, reason } of waiting.values()) {
    if (identity.runId === runId) entries.push({
      executionId: identity.id,
      workflowNodeId: identity.workflowNodeId,
      reason,
    })
  }
  return entries
}

/** Preparation is durable, so its reason survives backoff and a replacement engine owner. */
export async function readBrowserPreparationQueue(sql: SqlQuery, runId: string): Promise<ExecutionQueueEntry[]> {
  const rows = (await sql.query<{ execution_id: string; node_id: string; since: string; label: string | null;
    reason: string | null; unavailable: { reason?: string; message?: string } | null }>(`
    select p.execution_id,e.record->>'workflowNodeId' as node_id,e.record->>'createdAt' as since,
      n.record->>'labelAtAcceptance' as label,p.browser_unavailable as unavailable,
      coalesce(f.current_intent->>'reason',b.record->>'reason') as reason
    from workflow_collaboration_preparations p
    join harness_executions e on e.id=p.execution_id and e.run_id=p.run_id
    left join run_node_placements n on n.run_id=p.run_id and n.node_id=e.record->>'workflowNodeId'
    left join browser_profile_presence f on f.profile_id=p.browser_input#>>'{browser,profileId}'
      and f.computer_id=p.browser_input->>'computerId'
    left join browser_profile_replicas b on b.profile_id=f.profile_id and b.computer_id=f.computer_id
    where p.run_id=$1 and e.record->>'state'='queued' and p.browser_state in ('preparing','unavailable')
      and p.browser_release_reason is null`, [runId])).rows
  return rows.map(row => {
    const reason = row.unavailable?.message ?? row.reason ?? (row.unavailable?.reason
      ? `The browser is unavailable: ${row.unavailable.reason.replaceAll('_', ' ')}.`
      : 'Preparing the selected browser profile.')
    return { executionId: row.execution_id, workflowNodeId: row.node_id,
      reason: { kind: 'preparation', since: row.since,
        message: `Waiting for the browser profile on ${row.label ?? 'this computer'}: ${reason}` } }
  })
}

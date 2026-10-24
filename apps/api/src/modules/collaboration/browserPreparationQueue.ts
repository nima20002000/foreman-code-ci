import type { ExecutionQueueEntry } from '@foreman-code/contracts'
import type { SqlQuery } from '../../infrastructure/transaction.js'

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

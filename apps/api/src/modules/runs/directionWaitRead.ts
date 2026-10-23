import { RunDirectionWaitSchema, type RunDirectionWait } from '@foreman-code/contracts/current'
import type { AcceptedRepeatRunSnapshot } from './repeatStartRead.js'
import { parseHierarchyWorkResult } from './hierarchyResults.js'

interface DirectionQuery {
  query<Row extends object>(text: string, values: unknown[]): Promise<{ rows: Row[] }>
}

/** Findings are free JSON; an object's own words (message, summary, title...) read better than its JSON. */
export const findingText = (value: unknown) => {
  const words = value && typeof value === 'object' ? ['message', 'summary', 'title', 'description', 'detail', 'reason', 'text', 'finding']
    .map(key => (value as Record<string, unknown>)[key]).find(item => typeof item === 'string' && item.trim()) : undefined
  const text = (typeof value === 'string' ? value : typeof words === 'string' ? words : JSON.stringify(value)).trim()
  return text.length > 500 ? `${text.slice(0, 499)}…` : text
}

/** The Master turn held for a human direction, while the Run is still open for it. */
export async function readRunDirectionWaitLocked(sql: DirectionQuery,
  snapshot: Pick<AcceptedRepeatRunSnapshot, 'run' | 'version' | 'stopRequested'>): Promise<RunDirectionWait | undefined> {
  const { run, version } = snapshot
  if (!version.definition.hierarchy || snapshot.stopRequested || run.executionState === 'completed') return undefined
  const row = (await sql.query<{ workflow_node_id: string; held_execution_id: string; source_result_json: string;
    created_at: Date }>(`select workflow_node_id,held_execution_id,source_result_json,created_at
      from run_hierarchy_direction_waits where run_id=$1 and state='waiting'
      order by created_at desc,direction_id desc limit 1`, [run.id])).rows[0]
  if (!row) return undefined
  const node = version.definition.nodes.find(item => item.id === row.workflow_node_id)
  if (!node || node.kind === 'job') return undefined
  const result = parseHierarchyWorkResult(JSON.parse(row.source_result_json), version, row.workflow_node_id,
    run.resultProtocol)
  const findings = result.data.remainingFindings.map(findingText).filter(Boolean)
  return RunDirectionWaitSchema.parse({ workflowNodeId: node.id, agentId: node.agentId,
    agentName: node.name ?? node.label ?? 'Master', executionId: row.held_execution_id,
    ...(result.summary ? { summary: result.summary.slice(0, 600) } : {}),
    findings: findings.slice(0, 10), findingsCount: findings.length, since: row.created_at.toISOString() })
}

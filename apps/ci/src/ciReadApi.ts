import type pg from 'pg'
import { CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'

/**
 * The reads the product makes of CI-owned tables. Nothing outside this package queries `ci_runs`, `ci_group_requesters`
 * or the other CI tables for these facts, so the tables can move behind a service without touching Run or computer code.
 */

/** A pool, a checked-out client or a graph transaction. */
export interface CiSqlQuery {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>
}

/** Each execution that requested a ticket supplies its own Run and Agent identity. The initiator and shared-requester
 * paths are separate indexed lookups from this Run's executions, so the read never scans the workspace's tickets.
 * It is a self-contained `with` query ($1 Run, $2 workspace, $3 workflow, $4 workflow version) that the Run activity
 * snapshot embeds as one fact set, so CI facts share the database snapshot of the Run's other facts. */
export const AGENT_CI_SNAPSHOT_SQL = `with requesters as materialized (
    select e.id,e.agent_id,e.workflow_node_id,r.workspace_id,
      coalesce(e.record->>'agentConfigurationVersionId'=r.record->'agentConfigurationVersionIds'->>e.agent_id,false) as pinned
    from harness_executions e join runs r on r.id=e.run_id
    where r.id=$1 and r.workspace_id=$2 and r.workflow_id=$3 and r.workflow_version_id=$4
  ), requested as (
    select c.id,x.id as execution_id from requesters x
      join ci_runs c on c.workspace_id=x.workspace_id and c.record#>>'{initiator,executionId}'=x.id
    union
    select c.id,x.id from requesters x
      join ci_group_requesters q on q.workspace_id=x.workspace_id and q.execution_id=x.id
      join ci_runs c on c.workspace_id=q.workspace_id and c.group_id=q.group_id
  )
  select c.id::text,c.activity_record_revision::text as revision,
    e.id as execution_id,e.agent_id,e.workflow_node_id as node_id,c.record,
    coalesce(c.record->>'id'=c.id::text and c.record->>'workspaceId'=c.workspace_id
      and c.record->>'groupId'=c.group_id::text and c.record->>'state'=c.state and e.pinned,false) as pinned
  from requested m join ci_runs c on c.id=m.id join requesters e on e.id=m.execution_id
  order by c.created_at,c.id,e.id limit 16001`

/** Running CI per cloud provider on this Main: provider id to running ticket count. */
export async function countRunningCloudCi(sql: CiSqlQuery, mainId: string): Promise<Map<string, number>> {
  const counts = await sql.query<{ provider: string; running: number }>(`select split_part(host_key, ':', 3) as provider,
    count(*)::int as running from ci_runs where state in ('starting','running') and host_key like $1
    group by 1`, [`${mainId}:cloud:%`])
  return new Map(counts.rows.map(row => [row.provider, row.running]))
}

/** Tickets starting or running on this Main's own or paired computers, oldest first. */
export async function readRunningHostCiJobs(sql: CiSqlQuery, mainId: string,
  limit: number): Promise<{ run: CiRunRecord; workspaceName: string }[]> {
  const rows = await sql.query<{ record: unknown; workspace_name: string }>(`select c.record,
    w.record->>'name' as workspace_name from ci_runs c join workspaces w on w.id=c.workspace_id
    where c.state in ('starting','running') and c.record#>>'{computer,hostRef,mainId}'=$2
      and c.record#>>'{computer,hostRef,kind}' in ('main','device')
    order by c.created_at,c.id limit $1`, [limit, mainId])
  return rows.rows.map(row => ({ run: CiRunRecordSchema.parse(row.record), workspaceName: row.workspace_name }))
}

/** Whether any execution of the Run requested a CI ticket, as initiator or as a joined requester. */
export async function runRequestedCi(sql: CiSqlQuery, runId: string, workspaceId: string): Promise<boolean> {
  const found = await sql.query(`select 1 from ci_runs c join harness_executions e
    on (e.id=c.record#>>'{initiator,executionId}'
      or exists(select 1 from ci_group_requesters q where q.workspace_id=c.workspace_id
        and q.group_id=c.group_id and q.execution_id=e.id))
    where e.run_id=$1 and c.workspace_id=$2 limit 1`, [runId, workspaceId])
  return found.rows.length > 0
}

/** The newest tickets the Run's executions started, with the workflow node of the initiating execution. */
export async function readRunInitiatedCi(sql: CiSqlQuery, runId: string, workspaceId: string,
  limit: number): Promise<{ nodeId: string; record: CiRunRecord }[]> {
  const rows = await sql.query<{ node_id: string; record: unknown }>(
    `select e.workflow_node_id as node_id,c.record from ci_runs c join harness_executions e on e.id=c.record#>>'{initiator,executionId}'
     where e.run_id=$1 and c.workspace_id=$2 order by c.created_at desc,c.id desc limit $3`,
    [runId, workspaceId, limit])
  return rows.rows.map(row => ({ nodeId: row.node_id, record: CiRunRecordSchema.parse(row.record) }))
}

/** The read port for callers inside a graph transaction. */
export interface CiIdQuery {
  query(text: string, values: unknown[]): Promise<{ rows: { id: string }[] }>
}

/** Ids of the workspace's tickets this execution started or joined as an identical request; `ids` null means all. */
export async function ciTicketIdsRequestedByExecution(db: CiIdQuery, ids: readonly string[] | null,
  workspaceId: string, executionId: string): Promise<Set<string>> {
  const result = await db.query(`select id from ci_runs
    where ($1::uuid[] is null or id=any($1::uuid[]))
      and workspace_id=$2 and (record#>>'{initiator,executionId}'=$3 or group_id in (select q.group_id
        from ci_group_requesters q where q.workspace_id=$2 and q.execution_id=$3))`,
  [ids === null ? null : [...ids], workspaceId, executionId])
  return new Set(result.rows.map(row => row.id))
}

/** CI evidence for a Run activity, embedded in the same snapshot. Uses the activity (`a`), Run (`r`) and
 * execution (`e`) aliases of the product query; no CI table names escape this package. */
export const RUN_ACTIVITY_CI_JOIN_SQL = `left join ci_runs cq on a.kind='ci_state_changed'
  and cq.id=case when a.kind='ci_state_changed'
    and a.payload->>'ticketId' ~ '^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$'
    then (a.payload->>'ticketId')::uuid end
  and cq.id::text=a.payload->>'ticketId'
  and cq.workspace_id=r.workspace_id and (cq.record#>>'{initiator,executionId}'=e.id
    or exists(select 1 from ci_group_requesters q where q.workspace_id=cq.workspace_id
      and q.group_id=cq.group_id and q.execution_id=e.id))
  and cq.record->>'id'=cq.id::text and cq.record->>'workspaceId'=r.workspace_id
  and cq.group_id::text=a.payload#>>'{ci,groupId}' and cq.id::text=a.payload#>>'{ci,id}'
  and cq.record->>'suite'=a.payload#>>'{ci,suite}'
  and coalesce(cq.record->'part','null'::jsonb) is not distinct from a.payload#>'{ci,part}'
  and e.record->>'agentConfigurationVersionId'=r.record->'agentConfigurationVersionIds'->>e.agent_id`

/** Ticket count, terminality and latest timestamp for execution `e` in Run `r`. Embedded as a lateral
 * read so the stuck-execution detector keeps its single snapshot and row-lock selection. */
export const EXECUTION_CI_SUMMARY_SQL = `select count(*) as ticket_count,bool_and(c.state in ('passed','failed','canceled','lost')) as all_terminal,
          max(greatest((c.record->>'queuedAt')::timestamptz,(c.record->>'finishedAt')::timestamptz)) as last_activity_at
        -- Find the execution's tickets by index; a workspace's other tickets are never read.
        from ci_runs c where c.id in (
          select i.id from ci_runs i where i.workspace_id=r.workspace_id and i.record#>>'{initiator,executionId}'=e.id
          union
          select g.id from ci_group_requesters q join ci_runs g on g.workspace_id=q.workspace_id and g.group_id=q.group_id
            where q.workspace_id=r.workspace_id and q.execution_id=e.id)`

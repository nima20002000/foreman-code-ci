import type { SqlQuery } from '../../../infrastructure/transaction.js'
import { CLOSED_RUN_STATES_SQL } from '../../runs/runState.js'

/** Negative authority only: an explicit Stop, a durable terminal Run, or a
 * committed cleanup intent may cancel waits/revoke grants. None proves native
 * closure, changes the business outcome, or permits a native continuation.
 * The fixed alias r is used only by the owning Run queries below and readContext. */
export const RUN_CLEANUP_BOUNDARY_SQL = `(r.stop_requested_at is not null
  or r.execution_state in (${CLOSED_RUN_STATES_SQL})
  or exists(select 1 from run_cleanup_intents c where c.run_id=r.id and c.pending))`

export async function runCleanupAllowed(sql: SqlQuery, runId: string): Promise<boolean> {
  return (await sql.query(`select 1 from runs r where r.id=$1 and ${RUN_CLEANUP_BOUNDARY_SQL}`, [runId])).rowCount === 1
}

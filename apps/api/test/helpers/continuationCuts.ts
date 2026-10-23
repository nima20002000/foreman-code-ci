import type { GraphFact } from '@foreman-code/contracts/current'
import type { codexApprovalRuntime } from './codexApprovalRuntime.js'

export type ContinuationRuntime = Awaited<ReturnType<typeof codexApprovalRuntime>>

export function continuationAt<T>(point: Promise<T>, operation: Promise<unknown>): Promise<T> {
  return Promise.race([point, operation.then((result) => {
    const job = result as { state?: string; error?: { code?: string } } | undefined
    throw new Error(`Operation returned before the required native publication cut: ${job?.state ?? 'none'} ${job?.error?.code ?? ''}`)
  })])
}
export async function continuationAck(f: ContinuationRuntime, interactionId: string) {
  return (await f.db.pool.query<{ state: string; approval_native_ack_id: string | null; approval_native_ack_source: unknown }>(
    'select state,approval_native_ack_id,approval_native_ack_source from interaction_graph_resumes where interaction_id=$1',
    [interactionId])).rows[0]
}
export async function continuationBatches(f: ContinuationRuntime) {
  return (await f.db.pool.query<{ sequence: string; payload: string }>(
    "select sequence::text,payload from run_graph_batches where run_id=$1 and kind='events' order by sequence",
    [f.f.run.id])).rows.map((row) => ({ sequence: row.sequence,
    facts: (JSON.parse(row.payload) as { events: { fact: GraphFact }[] }).events.map((event) => event.fact) }))
}

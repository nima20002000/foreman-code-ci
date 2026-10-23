import {
  GraphNodeStateSchema, PublicGraphProjectionSchema, InputBindingSchema, RUN_GRAPH_LIMITS,
  repeatGraphTopologyCurrent, type PublicGraphProjection, type RunGraphScope, type WorkflowVersionCurrent,
} from '@foreman-code/contracts/current'
import { assertGraphTransaction } from './connection.js'
import type { SqlTransaction } from '../../infrastructure/transaction.js'
import { readRepeatGraphPinsLocked } from './repeatProjectionRows.js'
import { readCurrentGraphExchanges } from '../interactions/current/currentExchanges.js'
import { publicNodeState, type PublicExecution } from './publicLifecycle.js'
import { readPublicNodeProjection } from './publicProjection.js'
import { readPublicRunStateLocked } from './publicRunState.js'
import { readPublicAttentionCounts } from './currentAttention.js'
import { RunGraphError } from './errors.js'
import { readCompactProjectionRows } from './compactProjectionRows.js'
import type { CurrentNativeActivity } from './nativeActivitySelection.js'

export type CurrentExchanges = Pick<PublicGraphProjection, 'interactions' | 'reviews'>
export type ReadCurrentGraphExchanges = (sql: SqlTransaction, scope: RunGraphScope) => Promise<CurrentExchanges>
export type CompactExecution = PublicExecution
export function compactNodeState(workflowNodeId: string, current: CompactExecution | undefined,
  resolution: PublicGraphProjection['nodes'][number]['resolution'], native: readonly CurrentNativeActivity[] = [], closed = false) {
  return GraphNodeStateSchema.parse(publicNodeState(workflowNodeId, current, resolution, native, closed))
}

/** The same physical read model feeds G1's final projection delta and snapshots.
 * No native response, elapsed-time or missing-row inference occurs here. */
export async function readPublicProjectionLocked(sql: SqlTransaction, scope: RunGraphScope,
  pinnedVersion?: WorkflowVersionCurrent): Promise<PublicGraphProjection> {
  assertGraphTransaction(sql)
  const rows = await readCompactProjectionRows(sql, scope, pinnedVersion?.definition.nodes.map(node => node.id))
  const version = pinnedVersion ?? (await readRepeatGraphPinsLocked(sql, scope, rows.pins)).version
  const nodeIds = version.definition.nodes.map((node) => node.id)
  const attention = await readPublicAttentionCounts(sql, scope.runId, undefined, {}, rows.attention)
  for (const id of nodeIds) if (!attention.has(id)) attention.set(id, { pendingInteractionCount: 0,
    unsettledReviewCount: 0, cleanupPending: false, deliveryBlocked: false })
  const nodes = await readPublicNodeProjection(sql, scope, nodeIds, {}, attention, rows)
  if (rows.bindings.length > RUN_GRAPH_LIMITS.relationships) throw new RunGraphError('GRAPH_SNAPSHOT_TOO_LARGE')
  const inputBindings = rows.bindings.map(({ record, bound_at }) => InputBindingSchema.parse({
    bindingId: record.bindingId, relationshipId: record.source.relationshipId,
    sender: record.source.execution, recipient: record.recipient,
    acceptedResultDigest: record.source.acceptedResultDigest, recipientInputDigest: record.inputDigest,
    inputOrdinal: record.ordinal, boundAt: new Date(bound_at).toISOString(),
  }))
  return PublicGraphProjectionSchema.parse({ run: await readPublicRunStateLocked(sql, scope, attention, rows.runState), nodes, inputBindings,
    ...await readCurrentGraphExchanges(sql, scope, rows) })
}

/** Public composition retains a single current reader, not a version dispatcher. */
export function createCompactSnapshotAssembler(_readExchanges: ReadCurrentGraphExchanges) {
  void _readExchanges
  return async (sql: SqlTransaction, scope: RunGraphScope) => {
    const { version } = await readRepeatGraphPinsLocked(sql, scope)
    return { topology: repeatGraphTopologyCurrent(version), state: await readPublicProjectionLocked(sql, scope, version) }
  }
}

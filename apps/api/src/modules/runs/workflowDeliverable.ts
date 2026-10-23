import { workflowResultContext } from './resultContext.js'
import type { ExecutionResult, HarnessExecution, ResultProtocol } from '@foreman-code/contracts'
import { canonicalGraphJson, type OutputReferenceKind, type WorkflowVersionCurrent } from '@foreman-code/contracts/current'
import { deliverableFailure, deliverableVerdict, type DeliverableContract } from '../interactions/deliverable.js'
import { assertGraphTransaction } from '../run-graph/connection.js'
import type { SqlTransaction } from '../../infrastructure/transaction.js'
import { repeatTickIndex } from './repeatResolution.js'
import { ciTicketIdsRequestedByExecution } from '../ci/reads.js'

interface Queryable {
  readonly transaction?: true
  query(text: string, values: unknown[]): Promise<{ rows: { id: string }[] }>
}

const terminalVerdicts = new WeakMap<Queryable, Map<string, Promise<ExecutionResult | undefined>>>()

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i

/** References are valid only for records this same execution created, or CI groups it joined as an identical request. */
export async function referencesCreatedByExecution(db: Queryable, kind: OutputReferenceKind, values: readonly string[] | undefined,
  workspaceId: string, executionId: string): Promise<ReadonlySet<string>> {
  if (kind !== 'ciTicket') return new Set()
  const ids = values === undefined ? null
    : [...new Set(values.filter(value => UUID.test(value)).map(value => value.toLowerCase()))]
  if (ids?.length === 0) return new Set()
  const existing = await ciTicketIdsRequestedByExecution(db, ids, workspaceId, executionId)
  if (values === undefined) return existing
  return new Set(values.filter(value => existing.has(value.toLowerCase())))
}

/** The deliverable contract of one workflow Agent activation; none for interval checks or Job nodes. */
export function workflowDeliverableContract(version: WorkflowVersionCurrent, execution: HarnessExecution,
  referencesExist: DeliverableContract['referencesExist'], resultProtocol?: ResultProtocol): DeliverableContract | undefined {
  const node = version.definition.nodes.find(item => item.id === execution.workflowNodeId)
  if (!node || node.kind === 'job') return undefined
  const coordination = workflowResultContext(version, { ...execution, resultProtocol: resultProtocol ?? execution.resultProtocol })
  if (repeatTickIndex(execution.input) !== undefined && !coordination) return undefined
  const repeatExit = version.definition.repeat?.blocks.some(block => block.exitNodeId === node.id) ?? false
  return {
    source: version.definition.handoffs || repeatExit ? 'latestDeliverable' : coordination || node.choice || node.artifactOutputs ? 'data' : 'text',
    outputSchema: node.outputSchema, referencesExist, ...(coordination ? { coordination } : {}),
  }
}

/** Validate a terminal deliverable once per transaction, shared by normalization and native verification. */
export function workflowDeliverableFailure(db: Queryable, version: WorkflowVersionCurrent,
  execution: HarnessExecution, resultProtocol?: ResultProtocol): Promise<ExecutionResult | undefined> {
  if (execution.state !== 'completed' || execution.result?.outcome !== 'succeeded') return Promise.resolve(undefined)
  const read = async () => {
    const contract = workflowDeliverableContract(version, execution,
      (kind, values) => referencesCreatedByExecution(db, kind, values, version.workspaceId, execution.id), resultProtocol)
    const verdict = contract && await deliverableVerdict(execution.result!, contract)
    return verdict ? deliverableFailure(verdict) : undefined
  }
  if (!db.transaction) return read()
  assertGraphTransaction(db as SqlTransaction)
  let verdicts = terminalVerdicts.get(db)
  if (!verdicts) {
    verdicts = new Map()
    terminalVerdicts.set(db, verdicts)
  }
  const key = canonicalGraphJson([version.id, execution, resultProtocol ?? null])
  let verdict = verdicts.get(key)
  if (!verdict) {
    verdict = read()
    verdicts.set(key, verdict)
  }
  return verdict
}

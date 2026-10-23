import { isDeepStrictEqual } from 'node:util'
import { AcceptedWorkflowRunCurrentSchema, GraphIdSchema, type AcceptedWorkflowRunCurrent } from '@foreman-code/contracts/current'
import { assertGraphTransaction, beforeGraphCommit, poisonGraphTransaction } from '../run-graph/connection.js'
import type { SqlTransaction } from '../../infrastructure/transaction.js'
import { settleRepeatNativeExecutionsWithProofLocked } from '../interactions/repeatNativeSettlementBatch.js'
import { repeatNativePending } from '../interactions/repeatNativeEvidence.js'
import type { RunOwnership } from './ownership.js'
import type { RepeatRepositoryServices } from './repeatRepositoryHost.js'
import { readRepeatExecutionsLocked, type StoredRepeatExecution } from './repeatExecutionRead.js'
import { readAcceptedRepeatRunLocked } from './repeatStartRead.js'

/** Shared current settlement proof. Every ordinary attempt and actual repeat
 * occurrence is validated against exact input/terminal/closure/approval receipts.
 * Negative unbound work requires an explicit sealed entry or manager-dispose
 * receipt; no missing row or terminal enum authorizes cleanup. */
export const repeatSettlementServices = { assertSettlementLocked } satisfies Pick<RepeatRepositoryServices, 'assertSettlementLocked'>

function immutableRun(run: AcceptedWorkflowRunCurrent): unknown {
  const value: Record<string, unknown> = { ...run }
  // Selected-work completion in the enclosing transaction may advance only
  // these lifecycle fields. All accepted authority/location/config/input pins
  // remain identical, including future accepted fields not listed here.
  for (const key of ['executionState', 'outcome', 'result', 'startedAt', 'finishedAt']) delete value[key]
  return value
}
function executionPins(stored: StoredRepeatExecution): unknown {
  // Acceptance can change after settlement in the SAME terminal.accept G1.
  // It may not change the terminal execution, technical attempt, occurrence,
  // original input, slot or input digest that this proof settled.
  const { execution, ref, slotId, input, inputDigest } = stored
  return { execution, ref, slotId, input, inputDigest }
}

export async function assertSettlementLocked(sql: SqlTransaction, suppliedRun: AcceptedWorkflowRunCurrent,
  suppliedIds: readonly string[], owner: RunOwnership): Promise<void> {
  assertGraphTransaction(sql)
  try {
    const run = AcceptedWorkflowRunCurrentSchema.parse(structuredClone(suppliedRun))
    const ids = suppliedIds.map((id) => GraphIdSchema.parse(id)).sort()
    if (!ids.length || new Set(ids).size !== ids.length || owner.runId !== run.id) {
      return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
    }
    owner.assertOwned()
    const fence = structuredClone(await owner.readOneShotFence(sql))
    const snapshot = await readAcceptedRepeatRunLocked(sql, run.id)
    if (!isDeepStrictEqual(snapshot.run, run)) return repeatNativePending('RUN_PIN_CONFLICT')
    const executions = await readRepeatExecutionsLocked(sql, snapshot, ids)
    const captured: unknown[] = []
    for (const [index, stored] of executions.entries()) {
      // This reader verifies the exact ref, occurrence ancestry, configuration,
      // immutable input binding AND its canonical input.bind receipt on G1.
      if (stored.execution.id !== ids[index] || stored.execution.runId !== run.id) {
        return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
      }
      captured.push(structuredClone(executionPins(stored)))
    }
    // Native settlement retains its generation checks until commit.
    await settleRepeatNativeExecutionsWithProofLocked(sql, run.id, executions.map(stored => stored.execution))
    const checkOwner = async () => {
      owner.assertOwned()
      if (owner.runId !== run.id || !isDeepStrictEqual(fence, await owner.readOneShotFence(sql))) {
        return repeatNativePending('RUN_OWNERSHIP_LOST')
      }
      owner.assertOwned()
    }
    await checkOwner()
    beforeGraphCommit(sql, async () => {
      try {
        await checkOwner()
        const final = await readAcceptedRepeatRunLocked(sql, run.id)
        if (!isDeepStrictEqual(immutableRun(final.run), immutableRun(run))) return repeatNativePending('RUN_PIN_CONFLICT')
        const current = await readRepeatExecutionsLocked(sql, final, ids)
        for (const [index, stored] of current.entries()) {
          if (!isDeepStrictEqual(executionPins(stored), captured[index])) {
            return repeatNativePending('REPEAT_NATIVE_IDENTITY_CONFLICT')
          }
        }
        await checkOwner()
      } catch (error) {
        poisonGraphTransaction(sql)
        throw error
      }
    })
  } catch (error) {
    poisonGraphTransaction(sql)
    throw error
  }
}

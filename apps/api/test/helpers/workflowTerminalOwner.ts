import assert from 'node:assert/strict'
import type pg from 'pg'
import type { HarnessExecution } from '@foreman-code/contracts'
import type { WorkflowClosureStore } from '../../src/modules/interactions/workflowClosure.js'
import { assertGraphTransaction, ExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import type { RunOwnership } from '../../src/modules/runs/ownership.js'

/** Stored facts for local workflow credential recovery, backed by the fixture's actual close receipt. */
export function workflowTerminalOwner(readExecution: () => HarnessExecution,
  readClosure: WorkflowClosureStore['read'], principalIds: () => string[]) {
  const connection = new ExclusiveGraphConnection({ query: async (_text: string, values: unknown[] = []) => {
    const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length })
    const execution = readExecution()
    if (!values.length) return result()
    if (values.length === 1) {
      assert.deepEqual(values, [execution.runId])
      return result([{ id: execution.runId }])
    }
    if (values.length === 3) {
      assert.deepEqual(values, [execution.id, execution.runId, execution.agentId])
      return result(principalIds().map(principal_id => ({ principal_id })))
    }
    if (values.length === 2) {
      assert.deepEqual(values, [execution.id, execution.runId])
      const proof = await readClosure(execution)
      assert.ok(proof, 'credential recovery requires the fixture manager to record its close first')
      const saved = proof.execution
      const identity = { id: saved.id, runId: saved.runId, workflowNodeId: saved.workflowNodeId,
        agentId: saved.agentId, agentConfigurationVersionId: saved.agentConfigurationVersionId, attempt: saved.attempt,
        workingDirectory: saved.workingDirectory, runtimeDirectory: saved.runtimeDirectory }
      return result([{ generation: proof.durableGeneration, execution_identity: identity,
        expected_reference: proof.session, closed_reference: proof.session, closed: true,
        detached: false, detached_reference: null, closed_without_session: false, prior_unclosed: false,
        record: execution, reference: proof.session }])
    }
    throw new Error('Unexpected workflow credential recovery identity.')
  } } as unknown as pg.ClientBase, () => owner.assertOwned())
  const owner = { runId: readExecution().runId, assertOwned() {}, oneShotConnection: () => connection,
    readOneShotFence: async sql => {
      assertGraphTransaction(sql)
      return { ownerId: 'workflow-unit-owner', fence: '1' }
    },
  } as RunOwnership
  return { owner, connection }
}

import assert from 'node:assert/strict'
import type pg from 'pg'
import type { HarnessExecution } from '@foreman-code/contracts'
import type { WorkflowClosureStore } from '../../src/modules/interactions/workflowClosure.js'
import { assertGraphTransaction, ExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import type { RunOwnership } from '../../src/modules/runs/ownership.js'

/** Stored facts for local workflow credential recovery, backed by the fixture's actual close receipt. */
export function workflowTerminalOwner(readExecution: () => HarnessExecution,
  readClosure: WorkflowClosureStore['read'], principalIds: () => string[]) {
  const connection = new ExclusiveGraphConnection({ query: async (text: string, values: unknown[] = []) => {
    const q = text.replace(/\s+/g, ' ').trim()
    const result = (rows: unknown[] = []) => ({ rows, rowCount: rows.length })
    const execution = readExecution()
    if (q.startsWith('begin') || q === 'commit' || q === 'rollback') return result()
    if (q === 'select id from runs where id=$1 for update') {
      assert.deepEqual(values, [execution.runId])
      return result([{ id: execution.runId }])
    }
    if (q === 'select record from harness_executions where id=$1 and run_id=$2 for update') {
      assert.deepEqual(values, [execution.id, execution.runId])
      return result([{ record: execution }])
    }
    if (q.startsWith('select c.generation::text,c.execution_identity')) {
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
    if (q.startsWith('select b.principal_id from worker_credential_bindings b')) {
      assert.deepEqual(values, [execution.id, execution.runId, execution.agentId])
      return result(principalIds().map(principal_id => ({ principal_id })))
    }
    throw new Error(`Unscripted workflow credential recovery SQL: ${q}`)
  } } as unknown as pg.ClientBase, () => owner.assertOwned())
  const owner = { runId: readExecution().runId, assertOwned() {}, oneShotConnection: () => connection,
    readOneShotFence: async sql => {
      assertGraphTransaction(sql)
      return { ownerId: 'workflow-unit-owner', fence: '1' }
    },
  } as RunOwnership
  return { owner, connection }
}

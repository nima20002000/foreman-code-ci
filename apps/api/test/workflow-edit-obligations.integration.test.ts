import { describe, expect, it } from 'vitest'
import { HarnessExecutionSchema } from '@foreman-code/contracts'
import { AcceptedWorkflowRunCurrentSchema } from '@foreman-code/contracts/current'
import { readAffectedGraphRuns } from '../src/modules/graph-drafts/saveAdmission.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { currentDatabase, postgresEnabled } from './helpers/database.js'
import { graphFixture } from './graph-composition-fixture.js'

// These are persisted fault fixtures, not native settlement or Start receipts.
describe.skipIf(!postgresEnabled)('workflow edit persisted obligations', () => {
  it('requires canceled interaction retirement and finds a queued review through its owning interaction', async () => {
    const db = await currentDatabase()
    let app: Awaited<ReturnType<typeof graphFixture>>['app'] | undefined
    try {
      const t = await graphFixture(db, { form: 'single' })
      app = t.app
      const run = AcceptedWorkflowRunCurrentSchema.parse({ ...t.run, executionState: 'completed', outcome: 'succeeded',
        result: { outcome: 'succeeded', output: {} }, finishedAt: t.f.createdAt })
      await db.pool.query('update runs set execution_state=$2,record=$3::jsonb where id=$1',
        [run.id, run.executionState, JSON.stringify(run)])
      const scope = { workspaceId: run.workspaceId, workflowId: run.workflowId, stagedAgentIds: [] }
      const read = () => withTransaction(db.pool, sql => readAffectedGraphRuns(sql, scope))
      expect(await read()).toEqual([expect.objectContaining({ settled: true })])
      const identity = t.f.identities[0]!
      const execution = HarnessExecutionSchema.parse({ id: identity.executionId, runId: run.id,
        workflowNodeId: identity.workflowNodeId, agentId: identity.agentId, agentConfigurationVersionId: identity.agentConfigurationVersionId,
        attempt: 1, state: 'completed', input: {}, result: { outcome: 'succeeded', output: {} },
        nativeSessionId: 'edit-obligation-session', workingDirectory: run.executionLocation.rootPath,
        createdAt: t.f.createdAt, finishedAt: t.f.createdAt })
      await db.pool.query(`insert into harness_executions(id,run_id,workflow_node_id,agent_id,attempt,record)
        values($1,$2,$3,$4,1,$5::jsonb)`,
      [execution.id, run.id, execution.workflowNodeId, execution.agentId, JSON.stringify(execution)])
      const interaction = { id: 'edit-obligation-interaction', runId: run.id, workspaceId: run.workspaceId,
        workflowId: run.workflowId, executionId: execution.id, requestingAgentId: execution.agentId,
        nativeSessionId: execution.nativeSessionId, status: 'canceled', revision: 1, approval: run.approval }
      await db.pool.query(`insert into durable_interactions(id,workspace_id,workflow_id,run_id,execution_id,
        requesting_agent_id,harness,native_session_id,native_request_id,status,revision,record)
        values($1,$2,$3,$4,$5,$6,'codex',$7,'edit-request','canceled',1,$8::jsonb)`,
      [interaction.id, run.workspaceId, run.workflowId, run.id, execution.id, execution.agentId,
        execution.nativeSessionId, JSON.stringify(interaction)])
      expect(await read()).toEqual([expect.objectContaining({ settled: false, interactionPending: true, reviewPending: false })])
      // No reviewer execution exists: the interaction alone identifies the affected Run.
      await db.pool.query(`insert into review_jobs(id,interaction_id,reviewer_agent_id,state,record)
        values('edit-review',$1,$2,'queued',$3::jsonb)`,
      [interaction.id, execution.agentId, JSON.stringify({ id: 'edit-review', interactionId: interaction.id, state: 'queued' })])
      expect(await read()).toEqual([expect.objectContaining({ reviewPending: true })])
      await db.pool.query(`update review_jobs set state='failed',record=$1::jsonb where id='edit-review'`,
        [JSON.stringify({ id: 'edit-review', interactionId: interaction.id, state: 'failed', cleanup: { completedAt: t.f.createdAt } })])
      expect(await read()).toEqual([expect.objectContaining({ reviewPending: false, interactionPending: true })])
      // Missing native closure remains visible independently of the interaction and review obligations.
      expect(await read()).toEqual([expect.objectContaining({ nativePending: true })])
    } finally {
      await app?.close()
      await db.close()
    }
  })
})

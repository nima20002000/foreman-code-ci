import { describe, expect, it } from 'vitest'
import { readAffectedGraphRuns } from '../src/modules/graph-drafts/saveAdmission.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { postgresEnabled } from './helpers/database.js'
import { codexApprovalRuntime } from './helpers/codexApprovalRuntime.js'

describe.skipIf(!postgresEnabled)('workflow edit persisted obligations', () => {
  it('counts an undispatched review through its owning interaction and keeps cancellation pending until native closure', async () => {
    const f = await codexApprovalRuntime('orchestrator')
    try {
      await f.engine.start(f.f.run.id)
      const [interaction] = await f.pending()
      if (!interaction?.approval.designatedOrchestratorAgentId) throw new Error('Expected a routed approval')
      const review = await f.repository.coordination.findReviewJob(interaction.id, interaction.approval.designatedOrchestratorAgentId)
      expect(review).toMatchObject({ state: 'pending', attempt: 0 })
      expect(review?.submittedAt).toBeUndefined()
      const scope = { workspaceId: f.f.scope.workspaceId, workflowId: f.f.scope.workflowId, stagedAgentIds: [] }
      const read = () => withTransaction(f.db.pool, sql => readAffectedGraphRuns(sql, scope))
      expect(await read()).toEqual([expect.objectContaining({ settled: false, interactionPending: true, reviewPending: true })])
      // Stop acceptance and cancellation do not prove native closure or retire the interaction.
      await f.stop()
      await f.repository.cancelPendingForRun(f.f.run.id)
      expect(await f.repository.get(interaction.id)).toMatchObject({ status: 'canceled' })
      expect(await read()).toEqual([expect.objectContaining({ settled: false, interactionPending: true, nativePending: true })])
    } finally {
      await f.close()
    }
  })
})

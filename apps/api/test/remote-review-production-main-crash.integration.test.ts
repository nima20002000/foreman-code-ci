import { describe, expect, it } from 'vitest'
import { deliveredReview, retainedReviewRecovery, reviewInProgress, useRemoteReviewFixture, waitForRemoteReview,
  waitForReplacementReviewInventory }
  from './helpers/remoteReviewProductionCases.js'
import { SavedRunDetailsSchema } from '@foreman-code/contracts/wave25'
import { harnessConnectionGeneration } from '../src/modules/harnesses/hostConnectionGeneration.js'

const withRemoteReviewFixture = useRemoteReviewFixture()

describe('production remote review and native recovery through authenticated MCP', () => {
  it('waits for installations when the replacement connection arrives before inventory', async () => {
    await withRemoteReviewFixture(async fixture => {
      const previous = await fixture.inventory()
      const connection = previous.hostMetadata!.connection!
      const binding = { ...connection.binding, connectionEpoch: 'replacement-connection',
        connectionGeneration: connection.binding.connectionGeneration + 1 }
      const connecting = { ...previous, installations: [],
        hostMetadata: { ...previous.hostMetadata!, connection: { ...connection, binding } } }
      const ready = { ...connecting, installations: previous.installations.map(installation => ({
        ...installation, connectionGeneration: harnessConnectionGeneration(binding),
      })) }
      const snapshots = [connecting, { ...connecting, installations: previous.installations }, ready]
      let reads = 0
      const inventory = await waitForReplacementReviewInventory({ profiles: fixture.profiles, inventory: async () => {
        return snapshots[reads++]!
      } }, previous)
      expect(inventory).toEqual(ready)
      expect(reads).toBe(3)
    })
  })

  it.each(['crash'] as const)(
    'continues the original retained review after Main recovery from %s with the Worker alive', async recovery => {
      await withRemoteReviewFixture(fixture => retainedReviewRecovery(fixture, recovery))
    // Two full agent startups (reviewer, then requester) and a Main restart: ~60 s under a full parallel run.
    // The file stays within the suite's three-minute limit.
    }, 120_000,
  )
  it('publishes successful completion after the original review is delivered', async () => {
    await withRemoteReviewFixture(async fixture => {
      const active = await reviewInProgress(fixture)
      await fixture.provider.releaseReview()
      await deliveredReview(fixture, active.interaction.id)
      const completed = await waitForRemoteReview(async () => {
        await fixture.reconcile()
        return SavedRunDetailsSchema.parse(await fixture.value('run_get', {
          workspaceId: active.run.workspaceId, runId: active.run.id, detail: 'full',
        }))
      }, details => details.run.executionState === 'completed' && details.cleanupPending !== true,
      'persisted successful review completion')
      expect(completed.run.outcome).toBe('succeeded')
      expect(completed.executions.every(execution => execution.state === 'completed')).toBe(true)
      expect(SavedRunDetailsSchema.parse(await fixture.value('run_get', {
        workspaceId: active.run.workspaceId, runId: active.run.id, detail: 'full',
      })).run).toEqual(completed.run)
    })
  }, 120_000)
})

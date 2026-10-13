import { describe, expect, it } from 'vitest'
import { deliveredReview, reviewInProgress, retainedReviewRecovery, useRemoteReviewFixture, waitForReplacementReviewInventory }
  from './helpers/remoteReviewProductionCases.js'
import { remoteReviewProduction } from './helpers/remoteReviewProduction.js'
import { readUntil } from './helpers/observableCondition.js'
import { harnessConnectionGeneration } from '../src/modules/harnesses/hostConnectionGeneration.js'
import { DomainError } from '../src/modules/errors.js'
import { openRunGraphPublication, graphSourceDigest } from '../src/modules/run-graph/publication.js'
import { readPublicProjectionLocked } from '../src/modules/run-graph/compactSnapshot.js'
import { graphFixture, ownedGraph } from './eng04-graph-composition-fixture.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

describe('production remote review and native recovery through authenticated MCP', () => {
  const withRemoteReviewFixture = useRemoteReviewFixture()
  it.each(['APPROVAL_SETTLEMENT_PENDING', 'REPEAT_BOUNDARY_PENDING', 'REPEAT_CLEANUP_PENDING'])(
    'preserves %s when a graph mutation waits for native settlement', async code => {
      const db = await currentDatabase()
      let graph: Awaited<ReturnType<typeof graphFixture>> | undefined
      try {
        graph = await graphFixture(db, { form: 'single', qualifiedReads: true })
        const before = await graph.repeat.snapshot(graph.writer.principal, graph.readRequest)
        const pending = new DomainError(code, 'Native settlement is still pending.', 409)
        await expect(ownedGraph(db, graph, owner => owner.oneShotConnection().transaction(async sql => {
          const publication = await openRunGraphPublication(sql, graph!.scope, readPublicProjectionLocked)
          await publication.repeatChange({
            evidence: { sourceKind: 'run', sourceId: `settlement-${code}`, sourceRevision: '1' },
            sourceDigest: graphSourceDigest(code), effect: null,
          }, owner, async () => { throw pending }, async () => [])
        }))).rejects.toBe(pending)
        expect(await graph.repeat.snapshot(graph.writer.principal, graph.readRequest)).toEqual(before)
      } finally {
        await graph?.app.close()
        await db.close()
      }
    }, 30_000,
  )

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
})

it('settles the retained reviewer before publishing successful Run completion', async () => {
  const fixture = await remoteReviewProduction({ parallelSetup: true, parallelProfileChecks: true })
  try {
    const active = await reviewInProgress(fixture)
    await fixture.provider.releaseReview()
    await deliveredReview(fixture, active.interaction.id)
    const settled = await readUntil(async () => {
      await fixture.reconcile()
      return fixture.details(active.run.id)
    }, value => value.run.executionState === 'completed' && value.cleanupPending !== true,
    { timeoutMs: 15_000, description: 'Run completion after retained reviewer settlement' })
    expect(settled.run.outcome).toBe('succeeded')
    expect(settled.executions.every(execution => execution.state === 'completed')).toBe(true)
  } finally {
    await fixture.close()
  }
}, 120_000)

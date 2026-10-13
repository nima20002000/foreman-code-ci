import { describe, expect, it } from 'vitest'
import { retainedReviewRecovery, useRemoteReviewFixture, waitForReplacementReviewInventory }
  from './helpers/remoteReviewProductionCases.js'
import { executeRepeatRuntime } from '../src/modules/runs/repeatRuntime.js'
import { a1Scenario, graphHarness } from './helpers/eng04A1GraphHarness.js'
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
  const harness = graphHarness(a1Scenario('approval'))
  let retainedReviewerClosed = false
  let completed = false
  const lifecycle = {
    preflight: async () => undefined,
    markRunning: async () => undefined,
    currentState: async () => ({ executionState: completed ? 'completed' as const : 'running' as const,
      stopRequested: false }),
    persistWait: async () => false,
    cancelNativeAndRequestCleanup: async () => { throw new Error('Successful work was canceled.') },
    settleRun: async () => { throw new Error('Successful work was negatively settled.') },
    settleRetainedReviewers: async () => { retainedReviewerClosed = true },
    requestCleanup: async () => undefined,
    finishNative: async () => { expect(completed).toBe(true) },
    finishCleanup: async () => undefined,
  }
  const store = { ...harness.input.store, completeRun: async () => {
    if (!retainedReviewerClosed) throw new DomainError('REPEAT_CLEANUP_PENDING',
      'The retained reviewer still owns its native session and credential.', 409)
    await harness.input.store.completeRun()
    completed = true
  } }
  await executeRepeatRuntime({ ...harness.input, store, owner: { assertOwned() {} }, lifecycle })
  expect(completed).toBe(true)
  expect(harness.completeCalls).toBe(1)
})

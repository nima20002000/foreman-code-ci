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
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { RemoteOperationReceiptSchema, RemoteOwnerControlSchema } from '@foreman-code/contracts/remote-execution'
import { freezePlacement, deriveDispatch } from '../src/modules/placement/binding.js'
import { RemoteNativeSessionManager } from '../src/modules/runs/remote/nativeManagerProxy.js'
import { randomUUID } from 'node:crypto'

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

it('closes the retained native session through an explicit close command without requesting Run Stop', async () => {
  const mainId = randomUUID()
  const deviceId = randomUUID()
  const workerInstallationId = randomUUID()
  const digest = 'a'.repeat(64)
  const configuration = makeCurrentWorkflowFixture(randomUUID(), 'approval').configurations[0]!
  const placement = freezePlacement({ schemaVersion: 1, mainId, runId: 'run', nodeId: 'node',
    hostRef: { kind: 'device', mainId, deviceId }, registration: { workerInstallationId,
      keyRevision: 1, authorizationRevision: 1 }, mainInstallationId: 'main-installation',
    destination: { canonicalProjectRoot: '/project', canonicalCwd: '/project', managedRuntimeRoot: '/runtime',
      directoryIdentityHash: digest, rootPolicyId: 'policy', rootPolicyRevision: '1', locationRevision: '1',
      attestationId: 'attestation', attestationHash: digest },
    source: { revisionId: 'source', manifestDigest: digest, materializationId: 'materialization',
      materializationDigest: digest },
    payload: { kind: 'agent', agentId: configuration.agentId, agentConfigurationVersionId: configuration.id,
      driverId: 'codex', driverRevision: '1', instanceId: 'instance', instanceRevision: '1',
      harnessInstallationId: 'harness', installationFingerprint: digest, runtimeContractVersion: 1,
      protocolRevision: '1', credentialScopeRefs: [] },
  })
  const intent = deriveDispatch(placement, { executionId: 'execution', occurrenceId: null, occurrenceIndex: 0,
    technicalAttempt: 1, attemptId: 'attempt', operationId: 'operation', inputDigest: `sha256:${digest}`,
    owner: { grantId: 'grant', epoch: '1' } })
  const session = { harness: 'codex' as const, providerVersion: 'fixture', nativeSessionId: 'native-session' }
  let receipt = RemoteOperationReceiptSchema.parse({ schemaVersion: 1, intent,
    connection: { mainId, deviceId, workerInstallationId, bootId: randomUUID(), keyRevision: 1,
      authorizationRevision: 1, connectionGeneration: 1 }, workerIncarnationId: randomUUID(), sequence: 1,
    phase: 'running', native: { sessionId: session.nativeSessionId, turnId: 'workflow-turn',
      processIdentityDigest: digest }, entryAttempted: true, turnEntryAttempted: true,
    turnInput: { correlationId: 'execution:execution', promptDigest: digest }, stopFence: false, controls: [],
    retainedReviewer: { agentId: configuration.agentId, workflowTurnId: 'workflow-turn',
      expiresAt: new Date(Date.now() + 60_000).toISOString(), result: { outcome: 'succeeded' } },
  })
  const requested: string[] = []
  const manager = new RemoteNativeSessionManager({ intent, placement, harness: 'codex', configuration,
    observeReceipt: async () => undefined,
    controlFor: async command => {
      const kind: string = command.kind
      requested.push(kind)
      if (kind !== 'close') throw new DomainError('REMOTE_CONTROL_UNAVAILABLE',
        'Run Stop requires its cleanup intent.', 409)
      return RemoteOwnerControlSchema.parse({ schemaVersion: 1, protocolVersion: 1, commandId: 'close-native',
        operationId: intent.operationId, attemptId: intent.attemptId, executionId: intent.executionId,
        bindingHash: intent.bindingHash, owner: intent.owner, native: command.native, action: { kind: 'close' } })
    },
    transport: { request: async method => {
      if (method === 'prepare') return { session, status: { status: 'known', receipt } }
      if (method !== 'control') throw new Error(`Unexpected native request: ${method}`)
      receipt = RemoteOperationReceiptSchema.parse({ ...receipt, sequence: 2, phase: 'confirmed_terminal',
        terminal: { kind: 'completed', result: { outcome: 'succeeded' }, closureEvidenceDigest: digest } })
      return { status: 'known', receipt }
    } },
  })
  await manager.createSession({ correlationId: 'execution:execution', request: { executionId: intent.executionId,
    runId: intent.runId, workspaceId: configuration.workspaceId, workflowNodeId: intent.nodeId,
    workingDirectory: '/project', runtimeDirectory: '/runtime', configuration, input: {} } })
  await manager.close(session)
  expect(requested).toEqual(['close'])
})

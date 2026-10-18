import type pg from 'pg'
import { describe, expect, it, vi } from 'vitest'
import { HarnessExecutionSchema, ReviewJobSchema, type ReviewJob } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import type { NativeHarnessSessionManager, NativeHistory } from '../harnesses/port.js'
import { ExclusiveGraphConnection } from '../run-graph/connection.js'
import type { RunGraphPublication } from '../run-graph/publication.js'
import { readAcceptedRepeatRunLocked } from '../runs/repeatStartRead.js'
import { readRepeatExecutionLocked } from '../runs/repeatExecutionRead.js'
import { repeatDigest } from '../runs/repeatResolution.js'
import { nativeLanes } from '../../../test/helpers/nativeLanes.js'
import { coordinateSessionManager } from './sessionWriter.js'
import { createReviewNativeCaptureChannel } from './reviewNativeCapture.js'
import { ReviewNativeProofServices, type ReviewNativeProofRecord } from './reviewNativeProof.js'

vi.mock('../placement/persistence.js', () => ({ readExecutionPlacement: async () => undefined }))
vi.mock('../runs/repeatStartRead.js', () => ({ readAcceptedRepeatRunLocked: vi.fn() }))
vi.mock('../runs/repeatExecutionRead.js', () => ({ readRepeatExecutionLocked: vi.fn() }))
vi.mock('../run-graph/repeatReceipts.js', () => ({ requireRepeatCanonicalReceiptBeforeCommit: vi.fn() }))

async function fixture() {
  const f = makeCurrentWorkflowFixture('review-observation-recovery', 'approval')
  const node = f.version.definition.nodes.find(value => value.id === f.version.entryNodeId)!
  const session = { harness: 'codex' as const, providerVersion: 'fixture', nativeSessionId: 'retained-session' }
  const execution = HarnessExecutionSchema.parse({ id: 'reviewer-execution', runId: f.run.id,
    workflowNodeId: node.id, agentId: node.agentId, attempt: 1, state: 'completed', input: {},
    agentConfigurationVersionId: f.version.agentConfigurationVersionIds[node.agentId],
    createdAt: f.createdAt, finishedAt: f.createdAt, result: { outcome: 'succeeded' },
    workingDirectory: '/project', runtimeDirectory: '/runtime', nativeSessionId: session.nativeSessionId })
  const ref = { nodeId: node.id, occurrence: null }
  vi.mocked(readAcceptedRepeatRunLocked).mockResolvedValue({} as Awaited<ReturnType<typeof readAcceptedRepeatRunLocked>>)
  vi.mocked(readRepeatExecutionLocked).mockResolvedValue({
    execution, ref, inputDigest: repeatDigest(execution.input),
  } as Awaited<ReturnType<typeof readRepeatExecutionLocked>>)
  let job = ReviewJobSchema.parse({ id: 'retained-review', interactionId: 'pending-interaction',
    reviewerAgentId: execution.agentId, attempt: 1, state: 'acknowledged', provider: session.harness,
    nativeSessionId: session.nativeSessionId, correlationId: 'original-review-correlation',
    providerTurnOrMessageId: 'original-review-turn', submittedAt: f.createdAt, acknowledgedAt: f.createdAt,
    createdAt: f.createdAt, updatedAt: f.createdAt, leaseOwner: 'original-main', leaseToken: 'original-job-lease',
    leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() })
  const history: NativeHistory = { events: [{ sequence: 0, type: 'turn.started', occurredAt: f.createdAt,
    connectionId: 'original-worker-stream', payload: { threadId: session.nativeSessionId,
      turnId: job.providerTurnOrMessageId, clientCorrelationId: job.correlationId } }],
  correlationId: job.correlationId, nativeTurnId: job.providerTurnOrMessageId, pendingInteractions: [] }
  const coordination = nativeLanes()
  await coordination.ensureLane({ id: 'retained-lane', harness: session.harness,
    nativeSessionId: session.nativeSessionId, ownerAgentId: execution.agentId, observedStatus: 'busy',
    connectionGeneration: 1, correlationId: job.correlationId, currentTurnOrMessageId: job.providerTurnOrMessageId,
    observedAt: f.createdAt, revision: 0 })
  const writer = coordinateSessionManager({ harness: session.harness } as NativeHarnessSessionManager,
    coordination, execution.agentId)
  const channel = createReviewNativeCaptureChannel()
  const services = new ReviewNativeProofServices(channel.verify)
  const proofs = new Map<string, { record: ReviewNativeProofRecord; source_digest: string }>()
  let fence = '1'
  let lifetimeGeneration = 1
  const result = (rows: unknown[]) => ({ rows, rowCount: rows.length })
  const client = { async query(query: string, values: unknown[] = []) {
    const statement = query.trim().toLowerCase()
    if (statement.startsWith('begin') || statement === 'commit' || statement === 'rollback') return result([])
    if (query.startsWith('select 1 where')) {
      return result(new Date(String(values[0])).getTime() > Date.now() ? [{}] : [])
    }
    if (query.includes('from review_jobs')) return result([{ record: job, execution_id: execution.id,
      lease_fence: fence, lease_expires_at: new Date(job.leaseExpiresAt!), live: true }])
    if (query.includes('from execution_native_sessions')) return result([{ reference: session }])
    if (query.includes('from execution_native_closures')) return result([{ generation: '1', open: true }])
    if (query.includes('from native_session_lanes')) {
      const lane = (await coordination.getLane(session.harness, session.nativeSessionId))!
      return result([{ owner_agent_id: lane.ownerAgentId, harness: lane.harness,
        native_session_id: lane.nativeSessionId, generation: String(lane.connectionGeneration),
        token: lane.leaseToken, correlation: lane.correlationId, provider_id: lane.currentTurnOrMessageId,
        expires: new Date(lane.leaseExpiresAt!), live: true }])
    }
    if (query.includes('from review_native_proofs')) {
      const row = proofs.get(String(values[0]))
      return result(row ? [structuredClone(row)] : [])
    }
    if (query.includes('insert into review_native_proofs')) {
      proofs.set(String(values[0]), { record: JSON.parse(String(values[4])) as ReviewNativeProofRecord,
        source_digest: String(values[5]) })
      return result([{}])
    }
    throw new Error('Unexpected observation persistence query')
  } } as unknown as pg.ClientBase
  const connection = new ExclusiveGraphConnection(client, () => undefined)
  const observe = () => writer.withLane(session, job.correlationId, undefined, async (_manager, lease) => {
    const supplied = job
    const captured = channel.capture.capture({ execution, session, job: supplied, manager: writer, lease,
      lifetimeGeneration, closureGeneration: '1', source: { type: 'history', history }, assertCurrent() {} })
    return connection.transaction(async sql => {
      const publication = { sql, scope: f.scope, retainReviewSource: async (_id: string, _token: string, proofId: string) => ({
        evidence: { sourceKind: 'native_event', sourceId: proofId, sourceRevision: '1' },
        sourceDigest: repeatDigest(proofId), semanticDigest: repeatDigest([]),
      }) } as unknown as RunGraphPublication
      const first = await services.persistLocked(publication, supplied, captured)
      const replay = await services.persistLocked(publication, supplied, captured)
      expect(replay).toEqual(first)
      return first
    })
  })
  const recoverMain = () => {
    fence = '2'
    lifetimeGeneration = 2
    job = ReviewJobSchema.parse({ ...job, attempt: 2, leaseOwner: 'replacement-main', leaseToken: 'replacement-job-lease' })
  }
  return { observe, recoverMain, proofs, close: () => connection.close(), job: () => job }
}

describe('retained review history after observation handover', () => {
  it.each(['Main recovery', 'writer reattachment'] as const)(
    'records the unchanged native history under the current observer after %s', async handover => {
      const f = await fixture()
      try {
        const original = await f.observe()
        const saved = structuredClone(f.proofs.get(original.proofId))
        expect(f.proofs.size).toBe(1)
        if (handover === 'Main recovery') f.recoverMain()
        const recovered = await f.observe()
        expect(recovered.proofId).not.toBe(original.proofId)
        expect(recovered.jobLease.token).toBe(f.job().leaseToken)
        expect(recovered.jobLease.fence).toBe(handover === 'Main recovery' ? '2' : '1')
        expect(recovered.lane.token).not.toBe(original.lane.token)
        expect(recovered.original).toEqual(original.original)
        expect(recovered.job).toEqual(original.job)
        expect(recovered.execution).toEqual(original.execution)
        expect(f.proofs.size).toBe(2)
        expect(f.proofs.get(original.proofId)).toEqual(saved)
      } finally { await f.close() }
    },
  )
})

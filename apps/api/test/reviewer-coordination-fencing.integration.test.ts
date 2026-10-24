import pg from 'pg'
import { afterEach, expect, it } from 'vitest'
import { PostgresInteractionCoordinationRepository } from '../src/modules/interactions/coordination.js'
import { reviewCoordinationFixture } from './helpers/reviewCoordinationFixture.js'

let current: Awaited<ReturnType<typeof reviewCoordinationFixture>> | undefined
afterEach(async () => { await current?.close(); current = undefined })
async function fixture() { return current = await reviewCoordinationFixture() }

it.each(['pending', 'leased', 'submitted', 'acknowledged', 'uncertain', 'blocked_busy', 'blocked_disconnected'] as const)(
  'selects and claims recoverable %s work only after lease and retry expiry', async state => {
    const f = await fixture()
    const saved = { ...f.job, state, leaseExpiresAt: new Date(Date.now() + 60_000).toISOString() }
    await f.save(saved)
    expect(await f.coordination.nextReviewJob(f.reviewerId)).toBeUndefined()
    await f.save({ ...saved, leaseExpiresAt: '2000-01-01T00:00:00.000Z', retryAfter: new Date(Date.now() + 60_000).toISOString() })
    expect(await f.coordination.nextReviewJob(f.reviewerId)).toBeUndefined()
    await f.save({ ...saved, leaseExpiresAt: '2000-01-01T00:00:00.000Z', retryAfter: '2000-01-01T00:00:00.000Z' })
    expect(await f.coordination.nextReviewJob(f.reviewerId)).toMatchObject({ id: saved.id })
    const claimed = await f.coordination.claimReviewJob(saved.id, 'next', 'next-token', new Date(Date.now() + 60_000).toISOString())
    expect(claimed.state).toBe(['submitted', 'acknowledged', 'uncertain'].includes(state) ? state : 'leased')
    expect(claimed.correlationId).toBe(saved.correlationId)
    expect(await f.read()).toEqual(claimed)
  })

for (const method of ['assertLaneLease', 'assertReviewJobLease', 'renewLane', 'renewReviewJob'] as const) {
  it(`${method} rejects unconfirmed ownership and preserves database failures`, async () => {
    const f = await fixture()
    const confirm = (repository: PostgresInteractionCoordinationRepository) => method === 'renewLane' || method === 'renewReviewJob'
      ? repository[method](method.includes('Lane') ? f.lane.id : f.job.id, 'old-token', 30_000)
      : repository[method](method.includes('Lane') ? f.lane.id : f.job.id, 'old-token')
    await expect(confirm(f.coordination)).rejects.toMatchObject({ code: method.includes('Lane') ? 'SESSION_LANE_LEASE_LOST' : 'REVIEW_JOB_LEASE_LOST' })
    const url = new URL(f.db.databaseUrl); url.pathname = '/absent_review_coordination_database'
    const unavailable = new pg.Pool({ connectionString: url.toString() })
    try { await expect(confirm(new PostgresInteractionCoordinationRepository(unavailable))).rejects.toMatchObject({ code: '3D000' }) }
    finally { await unavailable.end() }
  })
}

it('claiming a native lane records actual busy ownership and rejects stale revision and live owners', async () => {
  const f = await fixture()
  expect(await f.coordination.getLane('codex', f.lane.nativeSessionId)).toMatchObject({ observedStatus: 'busy', leaseToken: 'writer' })
  await expect(f.coordination.claimLane(f.lane.id, f.lane.revision, 'successor', 'successor-token', new Date(Date.now() + 60_000).toISOString(), 'next'))
    .rejects.toMatchObject({ code: 'SESSION_LANE_BUSY' })
  expect(await f.coordination.getLane('codex', f.lane.nativeSessionId)).toEqual(f.lane)
})

it('review state changes fence both job and lane at the final database write', async () => {
  const f = await fixture()
  const next = await f.coordination.transitionReviewJob(f.job.id, 'token', 'failed', { writerFence: f.writer, releaseLease: false,
    error: { code: 'REVIEW_FAILED', message: 'Fixture failure' } })
  expect(await f.read()).toEqual(next)
  await f.coordination.releaseLane(f.lane.id, 'writer', { observedStatus: 'idle' })
  await expect(f.coordination.transitionReviewJob(f.job.id, 'token', 'failed', { writerFence: f.writer, releaseLease: false,
    error: { code: 'REVIEW_FAILED', message: 'Fixture failure' } }))
    .rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
  expect(await f.read()).toEqual(next)
})

it('expired job transition rolls back and never overwrites a successor', async () => {
  const f = await fixture()
  await f.save({ ...f.job, leaseExpiresAt: '2000-01-01T00:00:00.000Z' })
  const successor = await f.coordination.claimReviewJob(f.job.id, 'successor', 'successor-token', new Date(Date.now() + 60_000).toISOString())
  await expect(f.coordination.transitionReviewJob(f.job.id, 'token', 'completed')).rejects.toMatchObject({ code: 'REVIEW_JOB_LEASE_LOST' })
  expect(await f.read()).toEqual(successor)
})

it('releasing an expired lane cannot clear a successor lease', async () => {
  const f = await fixture()
  await f.coordination.releaseLane(f.lane.id, 'writer', { observedStatus: 'idle' })
  const idle = (await f.coordination.getLane('codex', f.lane.nativeSessionId))!
  const successor = await f.coordination.claimLane(idle.id, idle.revision, 'successor', 'successor-token', new Date(Date.now() + 60_000).toISOString(), 'next')
  await expect(f.coordination.releaseLane(idle.id, 'writer', { observedStatus: 'idle' })).rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
  expect(await f.coordination.getLane('codex', f.lane.nativeSessionId)).toEqual(successor)
})

it('durable acknowledgement refuses native turn identity replacement', async () => {
  const f = await fixture()
  const original = await f.coordination.transitionReviewJob(f.job.id, 'token', 'acknowledged', { providerTurnOrMessageId: f.job.providerTurnOrMessageId!, writerFence: f.writer, releaseLease: false })
  await expect(f.coordination.transitionReviewJob(f.job.id, 'token', 'acknowledged', { providerTurnOrMessageId: 'replacement', writerFence: f.writer, releaseLease: false }))
    .rejects.toMatchObject({ code: 'REVIEW_JOB_IDENTITY_CONFLICT' })
  expect(await f.read()).toEqual(original)
})

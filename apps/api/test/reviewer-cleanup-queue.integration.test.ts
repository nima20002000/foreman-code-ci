import { ReviewCleanupSchema } from '@foreman-code/contracts'
import { afterEach, describe, expect, it } from 'vitest'
import { reviewCoordinationFixture } from './helpers/reviewCoordinationFixture.js'

let current: Awaited<ReturnType<typeof reviewCoordinationFixture>> | undefined
afterEach(async () => { await current?.close(); current = undefined })
async function fixture() { return current = await reviewCoordinationFixture(true) }

describe('durable failed review cleanup queue and fencing', () => {
  it('selects failed incomplete cleanup fairly and preserves the failure and cleanup on claim', async () => {
    const f = await fixture()
    await f.save({ ...f.job, leaseExpiresAt: '2000-01-01T00:00:00.000Z' })
    expect(await f.coordination.nextReviewJob(f.reviewerId)).toMatchObject({ id: f.job.id })
    expect(await f.coordination.reviewJobAgents()).toContain(f.reviewerId)
    const claimed = await f.coordination.claimReviewJob(f.job.id, 'recovery', 'new-token', new Date(Date.now() + 60_000).toISOString())
    expect(claimed).toMatchObject({ state: 'failed', error: f.job.error, cleanup: f.job.cleanup })
    expect(await f.read()).toEqual(claimed)
    expect(await f.coordination.nextReviewJob(f.reviewerId)).toBeUndefined()
    await f.save({ ...claimed, leaseExpiresAt: '2000-01-01T00:00:00.000Z', cleanup: {
      nativeState: 'terminal', credentialState: 'revoked', interruptState: 'acknowledged', completedAt: new Date().toISOString(),
    } })
    expect(await f.coordination.nextReviewJob(f.reviewerId)).toBeUndefined()
    expect(await f.coordination.reviewJobAgents()).not.toContain(f.reviewerId)
  })
  it('journals failed cleanup without releasing its lease before side effects', async () => {
    const f = await fixture()
    const next = await f.coordination.transitionReviewJob(f.job.id, 'token', 'failed', {
      cleanup: f.job.cleanup, releaseLease: false, error: { code: 'NEW_ERROR', message: 'Do not overwrite.' }, writerFence: f.writer,
    })
    expect(next.leaseToken).toBe('token')
    expect(next.error).toEqual(f.job.error)
    expect(await f.read()).toEqual(next)
    const before = await f.read()
    await expect(f.coordination.transitionReviewJob(f.job.id, 'stale-token', 'failed', { releaseLease: false, writerFence: f.writer }))
      .rejects.toMatchObject({ code: 'REVIEW_JOB_LEASE_LOST' })
    await expect(f.coordination.transitionReviewJob(f.job.id, 'token', 'failed', { releaseLease: false, writerFence: { ...f.writer, token: 'stale' } }))
      .rejects.toMatchObject({ code: 'SESSION_LANE_LEASE_LOST' })
    expect(await f.read()).toEqual(before)
  })
  it('never revives a failed cleanup job or substitutes a successor credential', async () => {
    const f = await fixture(), before = await f.read()
    await expect(f.coordination.transitionReviewJob(f.job.id, 'token', 'submitted')).rejects.toMatchObject({ code: 'REVIEW_CLEANUP_CONFLICT' })
    for (const cleanup of [
      { ...f.job.cleanup!, credentialPrincipalId: 'successor-principal' },
      { ...f.job.cleanup!, nativeState: 'not_started' as const },
      { ...f.job.cleanup!, interruptState: 'submitted' as const },
    ]) await expect(f.coordination.transitionReviewJob(f.job.id, 'token', 'failed', { cleanup })).rejects.toMatchObject({ code: 'REVIEW_CLEANUP_CONFLICT' })
    expect(await f.read()).toEqual(before)
  })
  it('blocks binding new work into a lane with pending failure cleanup', async () => {
    const f = await fixture(), before = await f.coordination.getLane('codex', f.lane.nativeSessionId)
    await expect(f.coordination.bindLaneTurn(f.writer, 'new-turn')).rejects.toMatchObject({ code: 'SESSION_LANE_BUSY' })
    expect(await f.coordination.getLane('codex', f.lane.nativeSessionId)).toEqual(before)
  })
  it('rejects premature completedAt even when an interrupt was acknowledged', () => {
    const pending = { nativeState: 'pending', credentialState: 'pending', interruptState: 'acknowledged', completedAt: new Date().toISOString() }
    expect(ReviewCleanupSchema.safeParse(pending).success).toBe(false)
    expect(ReviewCleanupSchema.safeParse({ ...pending, nativeState: 'terminal' }).success).toBe(false)
    expect(ReviewCleanupSchema.safeParse({ ...pending, nativeState: 'terminal', credentialState: 'revoked' }).success).toBe(true)
  })
})

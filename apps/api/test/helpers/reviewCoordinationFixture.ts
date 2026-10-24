import type { ReviewJob } from '@foreman-code/contracts'
import { routedApprovalFixture } from './routedApprovalFixture.js'

export async function reviewCoordinationFixture(failed = false) {
  const f = await routedApprovalFixture()
  try {
    const lane = (await f.coordination.getLane('codex', f.reviewer.nativeSessionId!))!
    const writer = await f.coordination.claimLane(lane.id, lane.revision, 'worker', 'writer',
      new Date(Date.now() + 60_000).toISOString(), 'review-correlation')
    let job = await f.coordination.claimReviewJob(f.job.id, 'worker', 'token', new Date(Date.now() + 60_000).toISOString())
    if (failed) {
      // Seed a retained native acknowledgement; this fixture exercises cleanup, not native dispatch.
      job = { ...job, state: 'acknowledged', submittedAt: new Date().toISOString(),
        acknowledgedAt: new Date().toISOString(), providerTurnOrMessageId: 'original-review-turn' }
      await f.db.pool.query('update review_jobs set state=$2,record=$3::jsonb where id=$1',
        [job.id, job.state, JSON.stringify(job)])
      job = await f.coordination.transitionReviewJob(job.id, 'token', 'failed', {
        writerFence: { id: lane.id, token: 'writer' }, releaseLease: false, error: { code: 'ORIGINAL_FAILURE', message: 'Keep the original business failure.' },
        cleanup: { nativeState: 'pending', credentialState: 'pending', credentialPrincipalId: 'original-principal', interruptState: 'acknowledged' },
      })
    }
    const read = () => f.coordination.findReviewJob(job.interactionId, job.reviewerAgentId)
    const save = async (record: ReviewJob) => {
      await f.db.pool.query('update review_jobs set state=$2,record=$3::jsonb where id=$1', [job.id, record.state, JSON.stringify(record)])
    }
    return { ...f, job, lane: writer, writer: { id: lane.id, token: 'writer' }, read, save }
  } catch (error) { await f.close(); throw error }
}

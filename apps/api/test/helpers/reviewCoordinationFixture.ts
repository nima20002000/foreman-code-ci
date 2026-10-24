import type { ReviewJob } from '@foreman-code/contracts'
import { acknowledgementId, reviewEvidence } from '../../src/modules/interactions/current/nativeEvidence.js'
import { readContext } from '../../src/modules/interactions/current/context.js'
import { reviewFact, sourceForReview } from '../../src/modules/interactions/current/publication.js'
import { transact } from '../../src/modules/interactions/current/transaction.js'
import { graphSourceDigest } from '../../src/modules/run-graph/publication.js'
import { approvalDatabase } from './approvalDatabase.js'

export async function reviewCoordinationFixture(failed = false) {
  const f = await approvalDatabase()
  try {
    // Retain a real native acknowledgement, then drain its original observer.
    f.resumeObservation()
    await f.native.reviewers.shutdown()
    const coordination = f.repository.coordination
    const lane = (await coordination.getLane('codex', f.reviewer.nativeSessionId!))!
    const writer = await coordination.claimLane(lane.id, lane.revision, 'worker', 'writer',
      new Date(Date.now() + 60_000).toISOString(), f.job.correlationId)
    let job = await coordination.claimReviewJob(f.job.id, 'worker', 'token', new Date(Date.now() + 60_000).toISOString())
    if (failed) {
      job = await coordination.transitionReviewJob(job.id, 'token', 'failed', {
        writerFence: { id: lane.id, token: 'writer' }, releaseLease: false,
        error: { code: 'ORIGINAL_FAILURE', message: 'Keep the original business failure.' },
        cleanup: { nativeState: 'pending', credentialState: 'pending', credentialPrincipalId: f.principal.id, interruptState: 'acknowledged' },
      })
    }
    const read = () => coordination.findReviewJob(job.interactionId, job.reviewerAgentId)
    const save = (record: ReviewJob) => transact(f.pool, f.run.id, async publication => {
      const row = (await publication.sql.query<{ revision: string }>('select revision::text from review_jobs where id=$1 for update', [job.id])).rows[0]!
      const revision = String(BigInt(row.revision) + 1n)
      const context = await readContext(publication.sql, f.interaction)
      const native = await reviewEvidence(publication.sql, job.id)
      await publication.source({ evidence: sourceForReview(record, revision), sourceDigest: graphSourceDigest(record),
        facts: [reviewFact(context, record, revision, acknowledgementId(native))] }, async sql => {
        await sql.query('update review_jobs set state=$2,record=$3::jsonb,revision=revision+1 where id=$1',
          [job.id, record.state, JSON.stringify(record)])
      })
    })
    return { ...f, coordination, reviewerId: f.reviewer.agentId, job, lane: writer,
      writer: { id: lane.id, token: 'writer' }, read, save }
  } catch (error) { await f.close(); throw error }
}

import {
  AcceptedCurrentNodeResultSchema, WorkReturnSchema, canonicalGraphJson, parseWorkHandoffResult,
  type WorkActivationInput, type WorkReturn,
} from '@foreman-code/contracts/wave25'
import { frozenWorkNotice, readWorkLimitNoticeLocked } from './workHandoffNotice.js'
import { repeatConflict, repeatDigest, sameRepeatValue } from './repeatResolution.js'
import { workRequestSettlementsLocked, type WorkReturnContext } from './workReturnContinuation.js'

export async function readWorkReturnFeedbackLocked(context: WorkReturnContext, returned: WorkReturn) {
  const { sql, scope } = context
  const rows = (await sql.query<{ record: unknown; result_json: string; result_digest: string }>(
    `select t.record,x.result_json,x.result_digest from run_work_returns t
      join run_work_requests q on q.run_id=t.run_id and q.request_id=t.request_id
      join run_work_results x on x.run_id=t.run_id and x.execution_id=t.source_execution_id
      where q.run_id=$1 and q.requester_activation_id=$2 order by q.request_id`,
    [scope.runId, returned.requesterActivationId])).rows
  const feedback: NonNullable<Extract<WorkActivationInput['work'], { kind: 'work_return' }>['returns']> = []
  for (const row of rows) {
    const value = WorkReturnSchema.parse(row.record)
    const acceptedSourceResult = AcceptedCurrentNodeResultSchema.parse(JSON.parse(row.result_json))
    const response = parseWorkHandoffResult(acceptedSourceResult)
    if (!sameRepeatValue(value.scope, scope) || value.requesterActivationId !== returned.requesterActivationId
      || row.result_digest !== value.acceptedResultDigest
      || repeatDigest(acceptedSourceResult, 64 * 1024) !== row.result_digest
      || response.routing.kind !== 'return'
      || response.routing.requestId !== undefined && response.routing.requestId !== value.requestId
      || response.routing.outcome !== value.outcome
      || !sameRepeatValue(response.data.latestDeliverable, value.latestDeliverable)
      || !sameRepeatValue(response.data.remainingFindings, value.remainingFindings)) {
      return repeatConflict('WORK_RETURN_RESULT_CONFLICT')
    }
    const noticeExists = (await sql.query(`select 1 from run_work_notices
      where run_id=$1 and cause_kind='last_return' and cause_id=$2`, [scope.runId, value.returnId])).rowCount === 1
    const notice = noticeExists ? frozenWorkNotice(await readWorkLimitNoticeLocked(context,
      { kind: 'last_return', returnId: value.returnId })) : undefined
    feedback.push({ returned: value, acceptedSourceResult, ...(notice ? { notice } : {}) })
  }
  const primary = feedback.find(item => item.returned.returnId === returned.returnId)
  if (!primary || canonicalGraphJson(primary.returned) !== canonicalGraphJson(returned)) {
    return repeatConflict('WORK_RETURN_RESULT_CONFLICT')
  }
  const settled = await workRequestSettlementsLocked(context, returned.requesterActivationId)
  if (settled.pending) return repeatConflict('WORK_RETURN_PENDING')
  return { ...primary, returns: feedback, failures: settled.failures }
}

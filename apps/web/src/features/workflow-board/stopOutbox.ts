import { z } from 'zod'
import { RunStopInputSchema, RunStopResultSchema } from '@foreman-code/contracts/management'
import { RepeatGraphScopeV3Schema, sameWorkflowValue, type RepeatGraphScopeV3 } from '@foreman-code/contracts/wave25'
import { apiClient, ApiError, type ApiClient } from '../../shared/api/client'
import { protectedKey } from '../../shared/api/protectedChatStorage'
import { createOutboxView, readStoredCommand, withCommandLock, writeStoredCommand } from '../../shared/api/commandOutbox'
import { sessionIsSwitching, SessionChangedError } from '../../shared/api/sessionBoundary'

const StopJournalSchema = z.object({ scope: RepeatGraphScopeV3Schema, request: RunStopInputSchema, receipt: RunStopResultSchema.optional() }).strict()
  .superRefine((value, context) => {
    if (value.request.runId !== value.scope.runId || value.request.workspaceId !== value.scope.workspaceId
      || value.receipt && value.receipt.runId !== value.scope.runId) context.addIssue({ code: 'custom', message: 'Stop scope mismatch' })
  })
export type BoardStopJournal = z.infer<typeof StopJournalSchema>
export const boardStopKey = (scope: RepeatGraphScopeV3) => protectedKey('outbox', `board-stop:${JSON.stringify(RepeatGraphScopeV3Schema.parse(scope))}`)
const failure = 'Retained Stop storage is unavailable. No replacement command was sent.'
type Local = { journal?: BoardStopJournal; error?: string }
const view = createOutboxView<Local>()
export function readBoardStop(scope: RepeatGraphScopeV3): BoardStopJournal | undefined {
  if (sessionIsSwitching()) throw new SessionChangedError()
  RepeatGraphScopeV3Schema.parse(scope)
  const raw = readStoredCommand(boardStopKey(scope), failure)
  if (raw === undefined) return undefined
  const value = StopJournalSchema.parse(JSON.parse(raw))
  if (!sameWorkflowValue(value.scope, scope)) throw new Error('Retained Stop pins differ from this Run. No work was dispatched.')
  return value
}
function store(scope: RepeatGraphScopeV3, value?: BoardStopJournal) {
  writeStoredCommand(boardStopKey(scope), value ? JSON.stringify(StopJournalSchema.parse(value)) : undefined, failure)
  view.publish(boardStopKey(scope), { journal: value })
}
function locked<T>(scope: RepeatGraphScopeV3, action: () => T): Promise<T> {
  return withCommandLock(boardStopKey(scope), action,
    { unavailable: 'Cross-tab command reservation is unavailable. No Stop was sent.' })
}
export function reserveBoardStop(scope: RepeatGraphScopeV3): Promise<BoardStopJournal> {
  return locked(scope, () => {
    const existing = readBoardStop(scope)
    if (existing) return existing
    const next = StopJournalSchema.parse({ scope, request: { workspaceId: scope.workspaceId, runId: scope.runId, commandId: crypto.randomUUID() } })
    store(scope, next); return next
  })
}
export function createBoardStopClient(client: ApiClient = apiClient) {
  return async (journal: BoardStopJournal) => {
    const value = StopJournalSchema.parse(journal)
    const result = await client.request(`/api/management/workspaces/${encodeURIComponent(value.scope.workspaceId)}/runs/${encodeURIComponent(value.scope.runId)}/stop`,
      RunStopResultSchema, { method: 'POST', body: value.request })
    if (result.runId !== value.scope.runId) throw new ApiError({ code: 'INVALID_RESPONSE', message: 'Stop did not acknowledge the selected Run. Reconcile the retained command.' })
    return result
  }
}
export const sendBoardStop = createBoardStopClient()
export async function recordBoardStopReceipt(journal: BoardStopJournal, receipt: z.infer<typeof RunStopResultSchema>) {
  return locked(journal.scope, () => {
    const current = readBoardStop(journal.scope)
    if (!current || !sameWorkflowValue(current.request, journal.request)) throw new Error('The retained Stop command changed. Its journal is preserved.')
    store(journal.scope, StopJournalSchema.parse({ ...current, receipt }))
  })
}
/** Only called after exact, authenticated terminal AND cleanup-settled readback.
 * An accepted or already-terminal command receipt alone never clears this journal. */
export async function settleBoardStop(scope: RepeatGraphScopeV3, request: BoardStopJournal['request']) {
  return locked(scope, () => {
    const current = readBoardStop(scope)
    if (!current) return
    if (!sameWorkflowValue(current.request, request) || !current.receipt || current.receipt.status === 'not_owner') throw new Error('Stop settlement did not match its retained receipt.')
    store(scope)
  })
}
export function useBoardStopOutbox(scope: RepeatGraphScopeV3): Local {
  return view.useRecord(boardStopKey(scope), () => ({ journal: readBoardStop(scope) }),
    (error) => ({ error: error instanceof Error ? error.message : failure }))
    ?? { error: 'Checking retained Stop command.' }
}
export function clearBoardStopStorage() { view.clear() /* Principal teardown clears the protected namespace. */ }

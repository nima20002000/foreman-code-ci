import { sameWorkflowValue } from '@foreman-code/contracts/current'
import { createOutboxView, readStoredCommand, withCommandLock, writeStoredCommand } from '../../shared/api/commandOutbox'
import { protectedKey } from '../../shared/api/protectedChatStorage'
import { sessionIsSwitching, SessionChangedError } from '../../shared/api/sessionBoundary'
import { ApiError } from '../../shared/api/client'
import { nextDraftKey } from '../board-core'
import { parseBoardStart, type BoardStartInput } from './startClient'

/** One principal-scoped durable journal and cross-tab lock for current Start.
 * Invalid/retired stored tags are retained for explicit recovery, never dispatched. */
export const boardStartJournalKey = (key: string) => protectedKey('outbox', `next-draft-start:${key}`)
const storageError = 'Pending Start storage is unavailable. No replacement command can be sent.'
type Local = { request?: BoardStartInput; error?: string }
const view = createOutboxView<Local>()
const publish = (key: string, request?: BoardStartInput) => view.publish(boardStartJournalKey(key), { request })

export function readBoardStart(key: string): BoardStartInput | undefined {
  if (sessionIsSwitching()) throw new SessionChangedError()
  if (typeof window === 'undefined') return undefined
  const raw = readStoredCommand(boardStartJournalKey(key), storageError)
  if (raw === undefined) return undefined
  try {
    const request = parseBoardStart(JSON.parse(raw))
    if (nextDraftKey(request.workspaceId, request.workflowId) !== key) throw new Error('Start scope mismatch')
    return request
  } catch { throw new Error('The retained Start is invalid or out of scope. Recover its receipt before sending another command.') }
}

function locked<T>(key: string, work: () => T): Promise<T> {
  return withCommandLock(boardStartJournalKey(key), work,
    { unavailable: 'This browser cannot safely reserve a cross-tab Start. No Run was sent.' })
}

export async function reserveBoardStart(key: string, candidate: BoardStartInput): Promise<BoardStartInput> {
  return locked(key, () => {
    const existing = readBoardStart(key)
    if (existing) { publish(key, existing); return existing }
    const request = parseBoardStart(candidate)
    if (nextDraftKey(request.workspaceId, request.workflowId) !== key) throw new Error('Start scope mismatch')
    writeStoredCommand(boardStartJournalKey(key), JSON.stringify(request), storageError)
    publish(key, request)
    return request
  })
}

function removeExact(key: string, request: BoardStartInput): void {
  const current = readBoardStart(key)
  if (!current || !sameWorkflowValue(current, request)) throw new Error('The retained Start changed. Its journal was not cleared.')
  writeStoredCommand(boardStartJournalKey(key), undefined, storageError)
  publish(key)
}
export function acknowledgeBoardStart(key: string, request: BoardStartInput): Promise<'removed' | 'absent' | 'superseded'> {
  return locked(key, () => {
    if (nextDraftKey(request.workspaceId, request.workflowId) !== key) throw new Error('Start scope mismatch')
    const current = readBoardStart(key)
    if (!current) {
      publish(key)
      return 'absent'
    }
    if (current.commandId !== request.commandId) {
      publish(key, current)
      return 'superseded'
    }
    removeExact(key, request)
    return 'removed'
  })
}

/** Answers that cannot prove a lost earlier send of this command was not admitted. */
const uncertainStartCodes = ['RUN_START_BUSY', 'COMMAND_ID_CONFLICT', 'RUN_START_RECEIPT_CONFLICT',
  'RUN_START_RECEIPT_MISSING', 'RUNNER_ADMISSION_UNCERTAIN']
/** A definite 4xx domain rejection clears the exact command: the server reads the command's receipt before
 * these checks, so it was not admitted. Denial, rate limits, timeouts, transport and the codes above retain it. */
export function definiteStartRejection(error: unknown): error is ApiError {
  return ApiError.is(error) && error.status >= 400 && error.status < 500
    && ![401, 403, 408, 429].includes(error.status) && !uncertainStartCodes.includes(error.code)
}
export async function rejectBoardStart(key: string, request: BoardStartInput, error: unknown): Promise<boolean> {
  if (!definiteStartRejection(error)) return false
  return locked(key, () => { removeExact(key, request); return true })
}

/** Zustand stores only the local journal view. The caller's Query mutation owns requests. */
export function useBoardStartOutbox(key: string): Local {
  return view.useRecord(boardStartJournalKey(key), () => ({ request: readBoardStart(key) }),
    (error) => ({ error: error instanceof Error ? error.message : storageError }))
    ?? { error: 'Checking retained Start storage.' }
}

/** Called only by the existing principal/session teardown, never by Discard. */
export function clearBoardStartStorage(): void {
  view.clear()
  if (typeof window === 'undefined') return
  try {
    const prefix = boardStartJournalKey('')
    for (let index = window.localStorage.length - 1; index >= 0; index--) {
      const key = window.localStorage.key(index)
      if (key?.startsWith(prefix)) window.localStorage.removeItem(key)
    }
  } catch { /* ignore: protected principal teardown also removes its outbox namespace. */ }
}

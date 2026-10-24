import { z } from 'zod'
import { SessionControlRequestSchema, compactionBlocksSend, type SessionControlState, type SessionControlRequest } from '@foreman-code/contracts'
import { protectedKey } from '../../../shared/api/protectedChatStorage'
import { readStoredCommand, withCommandLock, writeStoredCommand } from '../../../shared/api/commandOutbox'
import { sessionSignal } from '../../../shared/api/sessionBoundary'
import { useConversationDraftStore } from '../conversationDraftStore'

const PendingControlSchema = z.object({
  request: SessionControlRequestSchema,
  draft: z.object({ key: z.string(), content: z.string() }).optional(),
}).strict()
export type PendingControl = z.infer<typeof PendingControlSchema>

const unavailable = 'Session control storage is unavailable. No control was sent.'
function storageKey(scope: string) { return protectedKey('outbox', `session-control:${scope}`) }
export function pendingControl(scope: string): PendingControl | null {
  const raw = readStoredCommand(storageKey(scope), unavailable)
  return raw === undefined ? null : PendingControlSchema.parse(JSON.parse(raw))
}
type ControlChange = SessionControlRequest extends infer Request ? Request extends SessionControlRequest
  ? Omit<Request, 'requestId' | 'expectedRevision'> : never : never

function exclusive<T>(scope: string, work: () => T): Promise<T> {
  return withCommandLock(storageKey(scope), work, { signal: sessionSignal(),
    unavailable: 'This browser cannot safely coordinate session controls across tabs. No control was sent.' })
}

export function reservePendingControl(scope: string, input: ControlChange, expectedRevision: number,
  draft?: PendingControl['draft']): Promise<PendingControl> {
  return exclusive(scope, () => {
    const pending = pendingControl(scope)
    if (pending) {
      const original = Object.fromEntries(Object.entries(pending.request)
        .filter(([field]) => field !== 'requestId' && field !== 'expectedRevision'))
      if (JSON.stringify(original) !== JSON.stringify(input)) {
        throw new Error('Recover the previous session control before changing settings.')
      }
      if (draft && !pending.draft) pending.draft = draft
    }
    const control = pending ?? { request: { ...input, requestId: crypto.randomUUID(), expectedRevision },
      ...(draft ? { draft } : {}) }
    writeStoredCommand(storageKey(scope), JSON.stringify(PendingControlSchema.parse(control)), unavailable)
    return control
  })
}

export function clearPendingControl(scope: string, requestId: string): Promise<void> {
  return exclusive(scope, () => {
    if (pendingControl(scope)?.request.requestId === requestId) writeStoredCommand(storageKey(scope), undefined, unavailable)
  })
}

export function recoverPendingControl(scope: string, state: SessionControlState): Promise<void> {
  return exclusive(scope, () => {
    const pending = pendingControl(scope)
    if (!pending) return
    const { request, draft } = pending
    const compact = state.compaction?.requestId === request.requestId ? state.compaction
      : state.compactions.find(entry => entry.requestId === request.requestId)
    if (request.kind === 'compact') {
      if (!compact || compactionBlocksSend(compact)) return
      if (compact.status !== 'failed' && draft) {
        useConversationDraftStore.getState().clearDraft(draft.key, draft.content)
      }
    } else {
      if (state.lastRequestId !== request.requestId && state.completedRequestId !== request.requestId) return
      if (draft) useConversationDraftStore.getState().clearDraft(draft.key, draft.content)
    }
    writeStoredCommand(storageKey(scope), undefined, unavailable)
  })
}

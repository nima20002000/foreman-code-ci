import { create } from 'zustand'
import { identityChangedEvent, parseChatPreferences, protectedKey } from '../../shared/api/protectedChatStorage'
import { sessionIsSwitching } from '../../shared/api/sessionBoundary'

export const operatorChatNarrowQuery = '(max-width: 600px)'
export function isNarrowOperatorChat(): boolean {
  return typeof window !== 'undefined' && typeof window.matchMedia === 'function'
    && window.matchMedia(operatorChatNarrowQuery).matches
}

interface OperatorChatUiState {
  open: boolean
  historyOpen: boolean
  selectedConversationId?: string
  draftConversationIds: string[]
  rememberDraft(id: string): void
  forgetDraft(id: string): void
  navigationGeneration: number
  /** One request from elsewhere in the app; the chat sends it in a new conversation. */
  request?: { id: string; content: string; send: boolean } | undefined
  ask(content: string, options?: { send?: boolean }): void
  takeRequest(id: string): void
  beginNavigation(): number
  setOpen(open: boolean): void
  setHistoryOpen(open: boolean): void
  select(id: string | undefined): void
  reset(): void
}
function savedState() {
  try { return parseChatPreferences(JSON.parse(window.localStorage.getItem(protectedKey('ui')) ?? '{}')) } catch { return {} }
}
function savedDraftIds(): string[] {
  try {
    const value: unknown = JSON.parse(window.localStorage.getItem(protectedKey('ui', 'draft-conversations')) ?? '[]')
    return Array.isArray(value) ? value.filter((id): id is string => typeof id === 'string' && !!id.trim()) : []
  } catch { return [] /* ignore: draft navigation remains available in memory. */ }
}
const initial = typeof window === 'undefined' ? {} : savedState()
function persist(state: Pick<OperatorChatUiState, 'open' | 'historyOpen' | 'selectedConversationId'>) {
  if (sessionIsSwitching()) return
  try { window.localStorage.setItem(protectedKey('ui'), JSON.stringify({ open: state.open, historyOpen: state.historyOpen, selectedConversationId: state.selectedConversationId })) } catch { /* Preferences are optional. */ }
}
export const useOperatorChatStore = create<OperatorChatUiState>((set) => ({
  open: initial.open ?? false,
  historyOpen: false,
  selectedConversationId: initial.selectedConversationId,
  navigationGeneration: 0,
  draftConversationIds: typeof window === 'undefined' ? [] : savedDraftIds(),
  rememberDraft: (id) => set((state) => {
    const draftConversationIds = [...new Set([...state.draftConversationIds, id])]
    try { window.localStorage.setItem(protectedKey('ui', 'draft-conversations'), JSON.stringify(draftConversationIds)) }
    catch { /* ignore: draft navigation remains available in memory. */ }
    return { draftConversationIds }
  }),
  forgetDraft: (id) => set((state) => {
    if (!state.draftConversationIds.includes(id)) return state
    const draftConversationIds = state.draftConversationIds.filter(value => value !== id)
    try { window.localStorage.setItem(protectedKey('ui', 'draft-conversations'), JSON.stringify(draftConversationIds)) }
    catch { /* ignore: draft navigation remains available in memory. */ }
    return { draftConversationIds }
  }),
  ask: (content, options) => { if (!sessionIsSwitching()) set((state) => {
    persist({ ...state, open: true })
    return { open: true, historyOpen: false, request: { id: crypto.randomUUID(), content, send: options?.send ?? true } }
  }) },
  takeRequest: (id) => set((state) => state.request?.id === id ? { request: undefined } : {}),
  beginNavigation: () => {
    let generation = 0
    set((state) => { generation = state.navigationGeneration + 1; return { navigationGeneration: generation } })
    return generation
  },
  setOpen: (open) => { if (!sessionIsSwitching()) set((state) => {
    const next = { open, historyOpen: false }
    persist({ ...state, ...next }); return next
  }) },
  setHistoryOpen: (historyOpen) => { if (!sessionIsSwitching()) set((state) => { persist({ ...state, historyOpen }); return { historyOpen } }) },
  select: (selectedConversationId) => { if (!sessionIsSwitching()) set((state) => {
    const next = { selectedConversationId, navigationGeneration: state.navigationGeneration + 1, historyOpen: isNarrowOperatorChat() ? false : state.historyOpen }
    persist({ ...state, ...next }); return next
  }) },
  reset: () => set((state) => ({ open: false, historyOpen: false, selectedConversationId: undefined, request: undefined, draftConversationIds: [], navigationGeneration: state.navigationGeneration + 1 })),
}))
if (typeof window !== 'undefined') window.addEventListener(identityChangedEvent, () => useOperatorChatStore.getState().reset())

/** Opens the Operator chat in a new conversation and sends the request, or only drafts it with `send: false`.
 * The card or button that asked updates from readback once the Operator acts. */
export function askOperator(content: string, options?: { send?: boolean }): void { useOperatorChatStore.getState().ask(content, options) }

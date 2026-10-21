import { create } from 'zustand'
import { raiseFloating } from '../../shared/ui/floatingStack'

interface ApprovalInboxScope {
  workspaceId: string
  workflowId?: string
}

interface ApprovalInboxUiState extends ApprovalInboxScope {
  open: boolean
  /** The button that opened the inbox; the window opens beside it (see shared/ui/floatingWindow). */
  anchor?: DOMRect
  openInbox(scope: ApprovalInboxScope, anchor?: DOMRect): void
  closeInbox(): void
}

export const APPROVAL_INBOX_STACK_ID = 'approval-inbox'

export const useApprovalInboxStore = create<ApprovalInboxUiState>((set) => ({
  open: false,
  workspaceId: '',
  openInbox: (scope, anchor) => { raiseFloating(APPROVAL_INBOX_STACK_ID); set({ ...scope, anchor, open: true }) },
  closeInbox: () => set({ open: false }),
}))

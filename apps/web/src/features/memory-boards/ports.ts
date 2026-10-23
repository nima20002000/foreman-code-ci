import type { MemoryWorkPageInfo } from '@foreman-code/contracts'
import type {
  AgentNodeRef, LogicalWorkRef, MemoryBoard, MemoryBoardChange, MemoryBoardChangesPage, MemoryBoardCommandRead,
  MemoryBoardMutation, MemoryBoardMutationReceipt, MemoryBoardScope, MemoryBoardView as MemoryBoardViewContract,
  MemoryCard, MemoryCardDetail as MemoryCardDetailContract, MemoryCardWorkBinding, MemoryCardWorkClaim, MemoryNote,
} from '@foreman-code/contracts'

/** Feature names for the canonical memory-board wire shapes in contracts. */
export type MemoryPage<T> = MemoryWorkPageInfo & { items: T[] }
export type CardStatus = MemoryCard['status']
export type OpenStatus = Exclude<CardStatus, 'done'>
export type MemoryBoardView = MemoryBoardViewContract
export type MemoryChange = MemoryBoardChange
export type MemoryActor = MemoryChange['actor']
export type MemoryCardDetail = MemoryCardDetailContract
export type MemoryReceipt = MemoryBoardMutationReceipt
export type MemoryCommandRead = MemoryBoardCommandRead
export type MemoryChangesPage = MemoryBoardChangesPage
export interface CardFilter {
  status: CardStatus
  completionKind?: 'completed' | 'dropped'
  query?: string
}
export interface PageOptions { cursor?: string; limit?: number; signal?: AbortSignal }
export type MemoryConnection = 'connecting' | 'connected' | 'reconnecting' | 'offline' | 'unavailable'
export interface MemoryStreamListeners {
  ready(): void
  change(change: MemoryChange): void
  reset(): void
  connection(state: MemoryConnection): void
}
export interface MemoryBoardClient {
  resolve(scope: MemoryBoardScope, signal?: AbortSignal): Promise<MemoryBoard>
  readBoard(boardId: string, signal?: AbortSignal): Promise<MemoryBoardView>
  readCards(boardId: string, filter: CardFilter, options?: PageOptions): Promise<MemoryPage<MemoryCard>>
  readCard(boardId: string, cardId: string, options?: PageOptions): Promise<MemoryCardDetail>
  readBindings(boardId: string, cardId: string, options?: PageOptions): Promise<MemoryPage<MemoryCardWorkBinding>>
  readClaims(boardId: string, cardId: string, options?: PageOptions): Promise<MemoryPage<MemoryCardWorkClaim>>
  readNotes(boardId: string, archived: boolean, options?: PageOptions): Promise<MemoryPage<MemoryNote>>
  readCommand(boardId: string, commandId: string, signal?: AbortSignal): Promise<MemoryCommandRead>
  readChanges(boardId: string, afterSequence?: number, options?: PageOptions): Promise<MemoryChangesPage>
  mutate(command: MemoryBoardMutation): Promise<MemoryReceipt>
  subscribe(boardId: string, listeners: MemoryStreamListeners): () => void
}
/** A bounded, already-authorized node/work projection supplied by D's shell. */
export interface MemoryNodeOption {
  node: AgentNodeRef
  label: string
  available: boolean
  currentWork: Array<{ work: LogicalWorkRef; label: string }>
}
export interface MemoryWorkHealth {
  bindingId: string
  state: 'online' | 'offline' | 'stale'
  lastSeenAt?: string
  continuing?: boolean
  stopping?: boolean
}
export interface MemoryFilters {
  query: string
  status?: CardStatus
  doneOpen: boolean
  completionKind?: 'completed' | 'dropped'
}

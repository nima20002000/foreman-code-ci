import type { RefObject } from 'react'
import type { OperatorConversationSummary } from '@foreman-code/contracts'
import { Button, EmptyState, Icon, LoadingState } from '../../shared/ui/nocturne'
import { sessionGeneration } from '../../shared/api/sessionBoundary'
import { OperatorHistoryActions } from './OperatorHistoryActions'
import { isNarrowOperatorChat, useOperatorChatStore } from './operatorChatStore'
import { operatorNavigationStatus } from './operatorChatStatus'
import { detailKey } from './operatorChatShared'
import { useManualRefetch } from '../../shared/api/useManualRefetch'
import { isApiRestartError } from '../../shared/api/client'
import type { useOperatorChatReadback } from './useOperatorChatReadback'
import type { useOperatorConversationMutations } from './useOperatorConversationMutations'

export function OperatorChatHistory({ historyOpen, historyId, historyRef, historyTriggerRef, list, entries, selectedId, accessDenied,
  creating, onNewChat, loadOlderChats, remove }: {
  historyOpen: boolean
  historyId: string
  historyRef: RefObject<HTMLElement | null>
  historyTriggerRef: RefObject<HTMLButtonElement | null>
  list: ReturnType<typeof useOperatorChatReadback>['list']
  entries: OperatorConversationSummary[]
  selectedId: string | undefined
  accessDenied: boolean
  creating: boolean
  onNewChat: () => void
  loadOlderChats: () => unknown
  remove: ReturnType<typeof useOperatorConversationMutations>['remove']
}) {
  const select = useOperatorChatStore((state) => state.select)
  const retry = useManualRefetch(list.refetch)
  const older = useManualRefetch(loadOlderChats)
  return <aside aria-hidden={!historyOpen} inert={!historyOpen} ref={historyRef} id={historyId} aria-label="Operator conversation history"
    onScroll={(event) => { const node = event.currentTarget; if (node.scrollHeight - node.scrollTop - node.clientHeight < 72) void older.refetch() }}>
    <Button variant="ghost" className="operator-chat-new" leading={<Icon name="plus" size={14} />} onClick={onNewChat} disabled={creating || accessDenied}>New chat</Button>

    {list.isPending ? <LoadingState label="Loading conversation history…" rows={3} /> : null}
    {/* While the app restarts, keep the loaded list (or the skeleton) instead of an error that clears itself seconds later. */}
    {list.isError && isApiRestartError(list.error) && !list.data ? <LoadingState label="Reconnecting…" rows={3} /> : null}
    {list.isError && !isApiRestartError(list.error) ? <div className="operator-history-error" role="alert">
      <span>{list.data ? 'History could not refresh.' : 'History could not load.'}</span>
      <Button size="sm" variant="ghost" disabled={retry.pending} loading={retry.pending} onClick={() => void retry.refetch()}>Retry</Button>
    </div> : null}
    {list.isSuccess && entries.length === 0 ? <EmptyState icon="history" title="No conversations yet. Start a new chat." /> : null}
    <nav aria-label="Conversations">{entries.map((item) => <div className="operator-chat-row" key={item.conversationId}>
      <Button variant="ghost" className="operator-chat-row-select" aria-current={item.conversationId === selectedId ? 'page' : undefined}
        onClick={() => { select(item.conversationId); if (isNarrowOperatorChat()) historyTriggerRef.current?.focus() }}
        title={`${item.title ?? 'Conversation'} · ${operatorNavigationStatus(item)}`}>
        <span className="operator-chat-title-clip"><span>{item.title ?? 'Conversation'}</span></span>
        <span className={`operator-chat-state-dot${item.needsAttention ? ' needs-attention' : ''}`} aria-label={operatorNavigationStatus(item)} />
      </Button>
      <OperatorHistoryActions summary={item} queryKey={detailKey(item.conversationId)}
        enabled={!accessDenied} removing={remove.isPending}
        onRemove={() => remove.mutate({ id: item.conversationId, title: item.title ?? 'Conversation', generation: sessionGeneration() })} />
    </div>)}</nav>
    {list.data?.hasMore ? <Button size="sm" variant="ghost" className="operator-chat-load-more" loading={older.pending} loadingLabel="Loading…" onClick={() => void older.refetch()}>Load older chats</Button> : null}
  </aside>
}

import { useEffect, useLayoutEffect, useRef, useState } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import type { AgentIdentity, ChatDeliveryReceipt, WorkflowChatPost, WorkflowChatPostResponse } from '@foreman-code/contracts'
import { Button, EmptyState, Icon, LoadingState, SegmentedControl } from '../../shared/ui/nocturne'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { isApiAccessError } from '../../shared/api/accessError'
import { useRememberedChatScroll } from '../conversations/chatScrollStore'
import { useChatOnline } from '../conversations/delivery/useChatDelivery'
import { useWorkflowChat, useWorkflowPost } from './useWorkflowChat'
import { workflowChatClient, type WorkflowChatScope } from './client'
import { readWorkflowDraft, useWorkflowDraftStore, workflowDraftKey } from './draft'
import { WorkflowChatComposer } from './WorkflowChatComposer'
import { WorkflowChatMessage } from './WorkflowChatMessage'
import { useWorkflowSelection } from './useWorkflowSelection'
import type { WorkflowTargetResolver } from './RecipientTargetPicker'
import './workflowChat.css'

export type WorkflowChatPanelProps = WorkflowChatScope & {
  visible: boolean
  participants: readonly AgentIdentity[]
  participantsLoading?: boolean
  participantsError?: string
  retryParticipants?: () => void
  resolveTargets: WorkflowTargetResolver
  currentRunId?: string
  selection: { runId?: string; postId?: string; receiptId?: string }
  onSelectionChange(selection: { runId?: string; postId?: string; receiptId?: string }): void
  onOpenAgent?: (post: WorkflowChatPost, receipt?: ChatDeliveryReceipt) => void
}

/** The shell owns destination/navigation. Hidden panels mount no queries or subscriptions. */
export function WorkflowChatPanel(props: WorkflowChatPanelProps) {
  return props.visible ? <WorkflowChatContent key={`${identityEpoch()}:${props.workspaceId}:${props.workflowId}`} {...props} /> : null
}

function WorkflowChatContent(props: WorkflowChatPanelProps) {
  const { selection, currentRunId, onSelectionChange } = props
  const chat = useWorkflowChat(props, selection.runId)
  const online = useChatOnline()
  const cache = useQueryClient(), scroll = useRef<HTMLDivElement>(null), following = useRef(true)
  const draftKey = workflowDraftKey(props)
  useRememberedChatScroll(`${draftKey}:${selection.runId ?? 'all'}`, scroll, following)
  const [recoveryKey, setRecoveryKey] = useState<string>()
  const [unread, setUnread] = useState(false)
  const [olderWindow, setOlderWindow] = useState(false)
  const connectedOnce = useRef(false)
  const selected = useWorkflowSelection(props, selection, !chat.denied, chat.revoke)
  const { focused, postId } = selected
  const update = () => { cancel.reset(); earlier.reset(); moreReceipts.reset(); exactReceipts.reset(); chat.refresh();
    if (postId) void focused.refetch(); if (selection.receiptId) void selected.receipt.refetch() }
  const cancel = useMutation({ mutationFn: (receipt: ChatDeliveryReceipt) => {
    if (!navigator.onLine) throw new Error('You are offline. Controls are unavailable.')
    return workflowChatClient.cancel(props, receipt.id, crypto.randomUUID())
  }, onSuccess: update })
  const earlier = useMutation({ mutationFn: async () => {
    const cursor = chat.data?.posts.nextCursor
    if (!cursor) return
    const page = await workflowChatClient.read(props, { runId: selection.runId, cursor })
    cache.setQueryData<typeof chat.data>(chat.key, previous => previous ? { ...previous, posts: { ...page,
      items: [...new Map([...page.items, ...previous.posts.items].map(post => [post.id, post])).values()].sort((a, b) => a.sequence - b.sequence).slice(0, 100) } } : previous)
    setOlderWindow(true)
  } })
  const exactReceipts = useMutation({ mutationFn: async (post: WorkflowChatPost) => {
    const page = await workflowChatClient.deliveries(props, { postId: post.id, limit: 100 })
    cache.setQueryData<typeof chat.data>(chat.key, previous => previous ? { ...previous,
      receipts: { ...previous.receipts, items: [...previous.receipts.items.filter(item => item.postId !== post.id), ...page.items] } } : previous)
    if (post.id === postId) await focused.refetch()
  } })
  const moreReceipts = useMutation({ mutationFn: async () => {
    if (!chat.data?.receipts.hasMore) return
    const page = await workflowChatClient.deliveries(props, { runId: selection.runId, cursor: chat.data.receipts.nextCursor ?? undefined })
    cache.setQueryData<typeof chat.data>(chat.key, previous => previous ? { ...previous, receipts: { ...page,
      items: [...new Map([...previous.receipts.items, ...page.items].map(receipt => [receipt.id, receipt])).values()] } } : previous)
  } })
  useLayoutEffect(() => {
    if (!scroll.current) return
    if (following.current) { scroll.current.scrollTop = scroll.current.scrollHeight; setUnread(false) }
    else setUnread(true)
  }, [chat.data?.posts.revision])
  useLayoutEffect(() => {
    if (postId && focused.data?.posts.items[0]) document.getElementById(`workflow-post-${postId}`)?.focus({ preventScroll: true })
  }, [postId, focused.data])
  const accessError = [focused.error, selected.receipt.error, cancel.error, earlier.error, moreReceipts.error, exactReceipts.error].some(isApiAccessError)
  const revoke = chat.revoke
  useEffect(() => { if (accessError) revoke() }, [accessError, revoke])
  const denied = chat.denied || accessError
  const openPost = (postId: string) => onSelectionChange({ runId: selection.runId, postId })
  const recover = (post: WorkflowChatPost, receipt: ChatDeliveryReceipt, choice: 'outside_run' | 'historical_follow_up') => {
    if (receipt.target.kind === 'operator_conversation') return
    const nodeId = receipt.target.agent.workflowNodeId
    const key = `${draftKey}:recovery:${receipt.id}:${choice}`
    const existing = readWorkflowDraft(key)
    if (!existing.body) useWorkflowDraftStore.getState().save(key, { body: post.body,
      mentions: post.mentions.filter(mention => mention.workflowNodeId === nodeId),
      deliveries: [], replyToPostId: post.id, recovery: { receiptId: receipt.id, sourcePostId: post.id, sourceTarget: receipt.target, choice } })
    setRecoveryKey(key)
  }
  const row = (post: WorkflowChatPost, exact = false) => {
    const data = exact ? focused.data : chat.data
    const receipts = data?.receipts.items.filter(receipt => receipt.postId === post.id) ?? []
    return <WorkflowChatMessage key={post.id} scope={props} post={post} receipts={receipts}
      controlsReason={!online ? 'You are offline. Controls are unavailable.' : undefined}
      truncated={data?.posts.bodyTruncations?.some(body => body.postId === post.id)}
      receiptsIncomplete={new Set(post.mentions.map(mention => mention.workflowNodeId)).size > receipts.length}
      onOpenPost={openPost} onCancel={receipt => cancel.mutate(receipt)} onRefresh={() => exactReceipts.mutate(post)} onDenied={chat.revoke}
      onRecover={(receipt, choice) => recover(post, receipt, choice)} onOpenAgent={props.onOpenAgent} />
  }
  if (denied) return <div className="workflow-chat-state"><EmptyState icon="lock" title="Chat isn’t available"
    description="You can’t read this group chat right now." action={<Button size="sm" onClick={update}>Try again</Button>} /></div>
  const posts = chat.data?.posts.items.filter(post => post.id !== postId) ?? []
  // The stream starts out "reconnecting" before its first open; only a lost connection is news.
  if (chat.connection === 'connected') connectedOnce.current = true
  const actionError = cancel.error ?? earlier.error ?? moreReceipts.error
  return <section className="workflow-chat-panel" aria-label="Group chat">
    {currentRunId ? <SegmentedControl label="Message history" value={selection.runId ?? ''}
      options={[{ value: '', label: 'All runs' }, { value: currentRunId, label: 'This run' }]}
      onValueChange={value => onSelectionChange({ ...selection, runId: value || undefined })} /> : null}
    {chat.query.isError ? <p className="workflow-chat-notice" role="status">
      {chat.data ? 'Showing saved messages. Reconnecting…' : 'Couldn’t load group chat.'}
      <Button size="sm" variant="ghost" onClick={chat.refresh}>Retry</Button></p>
      : chat.connection !== 'connected' && connectedOnce.current && chat.data ? <p className="workflow-chat-notice" role="status">Reconnecting…</p> : null}
    {selection.postId || selection.receiptId ? <aside className="workflow-chat-selected" aria-label="Selected post">
      <header><span>Selected message</span>
        <Button size="sm" variant="ghost" onClick={() => onSelectionChange({ runId: selection.runId })}>Back to all</Button></header>
      {selected.mismatch ? <p role="alert">This delivery belongs to a different message.
        {selected.receiptPostId ? <Button size="sm" variant="ghost" onClick={() => openPost(selected.receiptPostId!)}>Open that message</Button> : null}</p>
        : selection.receiptId && selected.receipt.isPending || postId && focused.isPending ? <LoadingState label="Loading message…" rows={1} /> : focused.data?.posts.items[0] ? row(focused.data.posts.items[0], true)
        : <p role="status">{focused.isError || selected.receipt.isError ? 'Couldn’t load this message.' : 'This message is no longer available.'}
          <Button size="sm" variant="ghost" onClick={() => { if (postId) void focused.refetch(); else void selected.receipt.refetch() }}>Retry</Button></p>}
    </aside> : null}
    <div ref={scroll} className="workflow-chat-transcript" role="region" aria-label="Workflow messages" tabIndex={0}
      onScroll={event => { const box = event.currentTarget; following.current = box.scrollHeight - box.scrollTop - box.clientHeight < 48 }}>
      {chat.data?.posts.hasMore ? <Button size="sm" variant="ghost" loading={earlier.isPending} onClick={() => { following.current = false; earlier.mutate() }}>Load earlier messages</Button> : null}
      {chat.query.isPending ? <LoadingState label="Loading group chat…" rows={3} />
        : chat.data && !posts.length && !postId ? <EmptyState icon="chat" title="No messages yet"
          description="Type @ to ask an agent in this workflow to act." /> : null}
      {posts.map(post => row(post))}
      {chat.data?.receipts.hasMore ? <Button size="sm" variant="ghost" loading={moreReceipts.isPending} onClick={() => moreReceipts.mutate()}>Load more delivery status</Button> : null}
    </div>
    {unread || olderWindow ? <Button className="workflow-chat-latest" size="sm" leading={<Icon name="down" size={14} />} onClick={() => { following.current = true; setOlderWindow(false); chat.refresh();
      if (scroll.current) scroll.current.scrollTop = scroll.current.scrollHeight; setUnread(false) }}>Latest</Button> : null}
    {actionError ? <p className="workflow-chat-notice" role="alert">{actionError.message}</p> : null}
    {recoveryKey ? <Button size="sm" variant="ghost" onClick={() => setRecoveryKey(undefined)}>Back to my draft</Button> : null}
    <WorkflowPostComposer key={recoveryKey ?? draftKey} {...props} draftKey={recoveryKey ?? draftKey}
      onDenied={chat.revoke} onPosted={result => { update(); openPost(result.post.id) }} />
  </section>
}

function WorkflowPostComposer(props: WorkflowChatPanelProps & { draftKey: string; onPosted(result: WorkflowChatPostResponse): void; onDenied(): void }) {
  const post = useWorkflowPost(props, props.onPosted, workflowChatClient, props.draftKey)
  const accessError = isApiAccessError(post.mutation.error) || !!post.denial
  const onDenied = props.onDenied
  useEffect(() => { if (accessError) onDenied() }, [accessError, onDenied])
  return <>
    {post.feedback ? <p className="workflow-chat-notice" role="alert">{post.feedback}</p> : null}
    {post.pending ? <div className="workflow-chat-notice" role="status">Not sure your last message was posted.
      <Button size="sm" variant="ghost" onClick={() => void post.reconcile()}>Check</Button>
      <Button size="sm" variant="ghost" disabled={post.mutation.isPending} onClick={() => void post.reconcile(true)}>Post again</Button>
    </div> : null}
    <WorkflowChatComposer scope={props} participants={props.participants} participantsLoading={props.participantsLoading}
      participantsError={props.participantsError} retryParticipants={props.retryParticipants} resolveTargets={props.resolveTargets}
      draftKey={props.draftKey} onSubmit={request => void post.post(request)} pending={post.mutation.isPending || !!post.pending} />
  </>
}

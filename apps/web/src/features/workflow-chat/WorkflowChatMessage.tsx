import { useInfiniteQuery } from '@tanstack/react-query'
import { isApiAccessError } from '../../shared/api/accessError'
import type { ChatDeliveryReceipt, WorkflowChatPost } from '@foreman-code/contracts'
import { Button } from '../../shared/ui/nocturne'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { ChatDeliveryReceipts } from '../conversations/delivery/ChatDeliveryReceipts'
import { workflowChatClient, type WorkflowChatScope } from './client'
import { agentLabel } from './mentions'

export function WorkflowChatMessage({ scope, post, receipts, truncated, receiptsIncomplete, onOpenPost, onCancel,
  onRecover, onOpenAgent, onRefresh, onDenied, controlsReason }: {
  scope: WorkflowChatScope
  post: WorkflowChatPost
  receipts: ChatDeliveryReceipt[]
  truncated?: boolean
  receiptsIncomplete?: boolean
  onOpenPost(postId: string): void
  onCancel(receipt: ChatDeliveryReceipt): void
  onRecover(receipt: ChatDeliveryReceipt, choice: 'outside_run' | 'historical_follow_up'): void
  onOpenAgent?: (post: WorkflowChatPost, receipt?: ChatDeliveryReceipt) => void
  onRefresh(): void
  onDenied(): void
  controlsReason?: string
}) {
  const body = useInfiniteQuery({ queryKey: ['workflow-chat-body', identityEpoch(), scope.workspaceId, scope.workflowId, post.id],
    enabled: false, initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      try { return await workflowChatClient.body(scope, post.id, pageParam, { signal }) }
      catch (error) { if (isApiAccessError(error)) onDenied(); throw error }
    },
    getNextPageParam: page => page.nextBodyCursor ?? undefined,
  })
  const pages = body.data?.pages
  const samePost = !pages || pages.every(page => page.postId === post.id)
  const text = pages && samePost ? pages.map(page => page.body).join('') : post.body
  const author = post.author.kind === 'agent' ? agentLabel(post.author.agent)
    : post.author.kind === 'system' ? 'Recorded by Foreman' : post.author.displayName
  return <article id={`workflow-post-${post.id}`} className="workflow-chat-message" data-author={post.author.kind} tabIndex={-1}>
    <header><strong>{author}</strong>
      <time dateTime={post.createdAt}>{new Date(post.createdAt).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}</time>
      {post.kind !== 'message' ? <span>{post.kind.replaceAll('_', ' ')}</span> : null}
      {post.execution ? <span>Run · attempt {post.execution.attempt}</span> : null}
      {onOpenAgent && (post.author.kind === 'agent' || post.execution) ? <Button size="sm" variant="ghost"
        onClick={() => onOpenAgent(post)}>Open chat</Button> : null}</header>
    {post.replyToPostId ? <Button size="sm" variant="ghost" onClick={() => onOpenPost(post.replyToPostId!)}>In reply to a message</Button> : null}
    <p className="workflow-chat-body">{text}</p>
    {truncated && !pages ? <Button size="sm" loading={body.isFetching && !body.isRefetching} onClick={() => void body.fetchNextPage()}>Show full message</Button> : null}
    {pages && body.hasNextPage ? <Button size="sm" loading={body.isFetching && !body.isRefetching} onClick={() => void body.fetchNextPage()}>Load more of this message</Button> : null}
    {body.isError || !samePost ? <p className="workflow-chat-notice" role="alert">Couldn’t load the full message. <Button size="sm" variant="ghost" onClick={() => void body.refetch()}>Retry</Button></p> : null}
    {post.mentions.length && receiptsIncomplete ? <p className="workflow-chat-notice" role="status">Some delivery status is still loading.
      <Button size="sm" variant="ghost" onClick={onRefresh}>Load</Button></p> : null}
    <ChatDeliveryReceipts receipts={receipts} controlsReason={controlsReason} onCancel={onCancel} onRefresh={onRefresh} onOpenPost={onOpenPost}
      onRecover={onRecover} onOpenContinuation={receipt => onOpenAgent?.(post, receipt)} />
  </article>
}

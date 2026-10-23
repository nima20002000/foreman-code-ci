import { useInfiniteQuery, useQuery } from '@tanstack/react-query'
import type { ChatDeliveryReceipt, DeliveryTarget } from '@foreman-code/contracts'
import { Button, MessageBubble } from '../../../shared/ui/nocturne'
import { identityEpoch } from '../../../shared/api/protectedChatStorage'
import { isApiAccessError } from '../../../shared/api/accessError'
import { ChatDeliveryReceipts } from './ChatDeliveryReceipts'
import { chatDeliveryClient, type RetainedInput as RetainedInputRecord } from './client'
import { useRetainedInputs, type RetainedInputsState } from './useRetainedInputs'

export type DirectRecovery = { origin: 'direct'; receipt: ChatDeliveryReceipt; input: RetainedInputRecord;
  choice: 'outside_run' | 'historical_follow_up' }

type RetainedCardProps = {
  target: DeliveryTarget; receipts: readonly ChatDeliveryReceipt[]; onDenied(error: Error): void
  onRecover?(recovery: DirectRecovery): void; onOpenGroup?(postId: string): void
  onCancel?(receipt: ChatDeliveryReceipt): void; onRefresh(): void; onOpenContinuation?(receipt: ChatDeliveryReceipt): void
  controlsReason?: string
}

/** Loading earlier inputs and read failures, for callers that place the input cards themselves. */
export function RetainedInputsStatus({ state }: { state: RetainedInputsState }) {
  const { inputs, restarting } = state
  return <>
    {inputs.isError && !restarting ? <p role="alert">Original inputs could not be loaded. <Button onClick={() => void inputs.refetch()}>Retry inputs</Button></p> : null}
    {inputs.hasNextPage ? <Button loading={inputs.isFetchingNextPage} onClick={() => void inputs.fetchNextPage()}>Load earlier inputs</Button> : null}
  </>
}

export function RetainedInput({ input, state, receipts, onRefresh, ...props }: RetainedCardProps & { input: RetainedInputRecord; state: RetainedInputsState }) {
  return <RetainedInputCard input={input} receipt={receipts.find(receipt => receipt.id === input.receiptId)} {...props}
    onRefresh={() => { void state.inputs.refetch(); onRefresh() }} />
}

/** Inputs that never reached a native message remain their own immutable, exact-target records. */
export function RetainedDeliveryInputs({ representedCommandIds, ...props }: RetainedCardProps & {
  /** Existing standalone user/queued rows already display these immutable inputs. */
  representedCommandIds?: readonly string[]
}) {
  const state = useRetainedInputs(props.target, props.onDenied, representedCommandIds)
  const { inputs, items, restarting } = state
  if (!items.length && !inputs.hasNextPage && (inputs.isPending || restarting || !inputs.isError)) return null
  return <section aria-label="Original delivery inputs">
    <h3 className="visually-hidden">Original delivery inputs</h3>
    <RetainedInputsStatus state={state} />
    {items.map(input => <RetainedInput key={input.receiptId} input={input} state={state} {...props} />)}
  </section>
}

function RetainedInputCard({ input, target, receipt, onDenied, onRecover, onOpenGroup, onCancel, onRefresh, onOpenContinuation, controlsReason }: {
  input: RetainedInputRecord; target: DeliveryTarget; receipt?: ChatDeliveryReceipt; onDenied(error: Error): void
  onRecover?(recovery: DirectRecovery): void; onOpenGroup?(postId: string): void
  onCancel?(receipt: ChatDeliveryReceipt): void; onRefresh(): void; onOpenContinuation?(receipt: ChatDeliveryReceipt): void
  controlsReason?: string
}) {
  const exactReceipt = useQuery({ queryKey: ['chat-delivery-receipt', identityEpoch(), JSON.stringify(target), input.receiptId],
    enabled: !receipt,
    queryFn: async ({ signal }) => {
      try {
        const result = await chatDeliveryClient.receiptById(target, input.receiptId, { signal })
        const exact = result.receipts.find(item => item.id === input.receiptId && item.commandId === input.commandId)
        if (!exact) throw new Error('The delivery receipt is unavailable for this original input.')
        return exact
      } catch (error) { if (isApiAccessError(error)) onDenied(error); throw error }
    } })
  const exact = exactReceipt.data
  const currentReceipt = exact && (!receipt || Date.parse(exact.updatedAt) >= Date.parse(receipt.updatedAt)) ? exact : receipt
  const refreshStatus = () => { void exactReceipt.refetch(); onRefresh() }
  const body = useInfiniteQuery({ queryKey: ['chat-delivery-input-body', identityEpoch(), JSON.stringify(target), input.receiptId],
    enabled: false, initialPageParam: undefined as string | undefined,
    queryFn: async ({ pageParam, signal }) => {
      try {
        const page = await chatDeliveryClient.inputs(target, { receiptId: input.receiptId, bodyCursor: pageParam }, { signal })
        const exact = page.items.find(item => item.receiptId === input.receiptId && item.commandId === input.commandId)
        if (!exact) throw new Error('The original input is unavailable for this receipt.')
        return exact
      } catch (error) { if (isApiAccessError(error)) onDenied(error); throw error }
    }, getNextPageParam: page => page.bodyCursor ?? undefined,
  })
  const pages = body.data?.pages, content = pages ? pages.map(page => page.content).join('') : input.content
  const incomplete = pages ? !!body.hasNextPage : input.truncated
  const original = { ...input, content, truncated: incomplete, bodyCursor: pages ? pages.at(-1)?.bodyCursor ?? null : input.bodyCursor }
  // Shown like any message you sent, with its delivery state under it.
  return <div className="agent-chat-message agent-chat-message--user" role="group" aria-label="Retained input"><MessageBubble author="You" role="user">
    <div className="conversation-message-content">{content}</div>
    {input.attachments.length ? <ul aria-label="Original file revisions">{input.attachments.map(file =>
      <li key={`${file.fileId}:${file.revisionId}`}>File {file.fileId} · Revision {file.revisionId}</li>)}</ul> : null}
    {incomplete ? <Button loading={body.isFetching && !body.isRefetching} onClick={() => void body.fetchNextPage()}>{pages ? 'Load more input' : 'Show full input'}</Button> : null}
    {body.isError ? <p role="alert">Could not load the full input. <Button onClick={() => void body.refetch()}>Retry full input</Button></p> : null}
    {input.origin === 'group' && input.sourcePostId ? <p>Reply belongs to Group chat.
      {onOpenGroup ? <Button onClick={() => onOpenGroup(input.sourcePostId!)}>Open Group message</Button> : null}</p> : null}
    {currentReceipt ? <ChatDeliveryReceipts receipts={[currentReceipt]} onCancel={onCancel} onOpenContinuation={onOpenContinuation} controlsReason={controlsReason} onRefresh={refreshStatus}
      onRecover={input.origin === 'direct' && onRecover && !incomplete ? (failed, choice) => onRecover({ origin: 'direct', receipt: failed, input: original, choice }) : undefined} />
      : <p role="status">{exactReceipt.isError ? 'Delivery status could not be loaded.' : 'Delivery status is loading.'} <Button onClick={refreshStatus}>Refresh delivery status</Button></p>}
    {currentReceipt && exactReceipt.isError ? <p role="alert">Delivery status could not be refreshed. The last known receipt is shown.
      <Button disabled={exactReceipt.isFetching && !exactReceipt.isRefetching} onClick={refreshStatus}>Retry status</Button></p>
      : null}
    {currentReceipt?.errorCode === 'TARGET_SETTLED' && input.origin === 'direct' ? <p>Recovery opens a direct Agent composer. Your reply stays in direct chat.</p> : null}
  </MessageBubble></div>
}

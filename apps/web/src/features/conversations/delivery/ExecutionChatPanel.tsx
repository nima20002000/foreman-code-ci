import '../agentChat/agentChat.css'
import { Fragment, useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { parseSessionCommand, type ChatDeliveryIntent, type ChatDeliveryReceipt, type EngineChatReadback, type SessionMode } from '@foreman-code/contracts'
import { Alert, Button, LoadingState } from '../../../shared/ui/nocturne'
import { identityEpoch } from '../../../shared/api/protectedChatStorage'
import { isApiAccessError } from '../../../shared/api/accessError'
import type { ConversationAttachments } from '../../attachments'
import { ConversationViewport } from '../ConversationViewport'
import { AgentChatComposer } from '../agentChat/AgentChatComposer'
import { sameStructuredResult } from '../agentChat/structuredResult'
import { useConversationDraftStore, prepareChatAttachments, type ChatAttachmentAttempt, deliveryAction } from '../../chat-core'
import { ChatDeliveryActions } from './ChatDeliveryActions'
import { ChatDeliveryReceipts } from './ChatDeliveryReceipts'
import { RetainedInput, RetainedInputsStatus, type DirectRecovery } from './RetainedDeliveryInputs'
import { useRetainedInputs } from './useRetainedInputs'
import { chatDeliveryClient } from './client'
import { useChatDelivery } from './useChatDelivery'
import { useDeliveryDraftPin } from './useDeliveryDraftPin'
import { type ExecutionChatSource, type ExecutionChatTarget } from './executionChatSource'
import { ExecutionNativeMessage } from './ExecutionNativeMessage'
import { useExecutionChatStream } from './useExecutionChatStream'

export type ExecutionChatPanelProps = {
  visible: boolean; target: ExecutionChatTarget; name: string; source: ExecutionChatSource
  /** Supplied only by the qualified current-turn observer, never inferred from transcript history. */
  nativeTurnId?: string; unavailableReason?: string; attachments?: ConversationAttachments; attachmentControl?: ReactNode
  sessionMode?: SessionMode; appliedSessionMode?: SessionMode
  onOpenContinuation?(receipt: ChatDeliveryReceipt): void; onOpenGroup?(postId: string): void
  /** The Agent chat that continues a finished execution's session; shown in place of this panel when it takes no input. */
  followUp?: ReactNode
  onRecover?(recovery: DirectRecovery): void
}

export function ExecutionChatPanel(props: ExecutionChatPanelProps) {
  return props.visible ? <ExecutionChatContent key={`${identityEpoch()}:${JSON.stringify(props.target)}`} {...props} /> : null
}

function ExecutionChatContent(props: ExecutionChatPanelProps) {
  const cache = useQueryClient(), serialized = JSON.stringify(props.target)
  const target = useMemo(() => JSON.parse(serialized) as ExecutionChatTarget, [serialized])
  const draftKey = `execution-chat:${serialized}`, inputRef = useRef<HTMLTextAreaElement>(null)
  const detailAbort = useRef(new AbortController())
  useEffect(() => () => detailAbort.current.abort(), [])
  const draft = useConversationDraftStore(store => store.drafts[draftKey] ?? '')
  const [intent, setIntent] = useState<ChatDeliveryIntent>('auto'), [denied, setDenied] = useState(false)
  const [older, setOlder] = useState<EngineChatReadback>()
  const attempted = useRef<{ content: string; version: number; files?: ChatAttachmentAttempt } | undefined>(undefined)
  const revoke = useCallback((error: Error) => {
    if (!isApiAccessError(error)) return
    setDenied(true); setOlder(undefined); detailAbort.current.abort()
    const matches = (query: { queryKey: readonly unknown[] }) => query.queryKey.some(part => part === serialized)
    void cache.cancelQueries({ predicate: matches }); cache.removeQueries({ predicate: matches })
  }, [cache, serialized])
  const delivery = useChatDelivery(target, !denied && !props.unavailableReason, 'selected', (_receipt, request) => {
    if (attempted.current?.content === request.content) {
      useConversationDraftStore.getState().clearExactDraft(draftKey, request.content, attempted.current.version)
      attempted.current.files?.acknowledge?.()
    }
    void cache.invalidateQueries({ queryKey: ['chat-delivery-inputs', identityEpoch(), serialized] })
  }, { nativeTurnId: props.nativeTurnId, onDenied: revoke, pollMs: 3000 })
  const stream = useExecutionChatStream(target, props.source, delivery.queryKey, !denied && !delivery.denied, revoke)
  const state = delivery.state && 'messages' in delivery.state ? delivery.state : undefined
  const history = useMutation({ mutationFn: async () => {
    if (!stream.historyReady) return
    const cursor = older?.nextCursor ?? state?.nextCursor
    if (cursor) {
      const signal = detailAbort.current.signal
      const page = await chatDeliveryClient.page(target, cursor, { signal })
      signal.throwIfAborted(); setOlder(page)
    }
  }, onError: revoke })
  const pin = useDeliveryDraftPin(draftKey, target, delivery.presentation.nativeTurnId, !!draft || !!props.attachments?.hasAttachments, !!delivery.state)
  const command = parseSessionCommand(draft), mode = command.kind === 'plan-task' ? 'plan' : props.sessionMode
  const sessionCommand = command.kind === 'compact' || command.kind === 'mode' || command.kind === 'new'
  const sessionReason = 'Session commands are unavailable for this selected execution. Use /plan followed by a task to send Plan input.'
  const presentation = { ...delivery.presentation, hasAttachments: props.attachments?.hasAttachments,
    changesMode: !!mode && mode !== props.appliedSessionMode }
  const controlsReason = !delivery.online ? 'You are offline. Controls are unavailable.' : undefined
  const reason = props.unavailableReason ?? (command.kind === 'invalid' ? command.message : sessionCommand ? sessionReason : delivery.pendingControl ? 'Confirm the original Stop or queue control before sending.'
    : pin.stale ? 'The selected turn changed. Refresh the target to send this draft.' : !delivery.online ? 'You are offline. Your draft is kept.' : undefined)
  const submit = (content = draft) => {
    const parsed = parseSessionCommand(content)
    if (parsed.kind === 'compact' || parsed.kind === 'mode' || parsed.kind === 'new') return
    if (reason || deliveryAction(presentation, intent).reason || delivery.busy || delivery.pending) return
    const files = props.attachments ? prepareChatAttachments(props.attachments) : { attachments: [] }
    if (!files || !content.trim() && !files.attachments.length) return
    attempted.current = { content, version: useConversationDraftStore.getState().versions[draftKey] ?? 0, files }
    delivery.submit({ content, intent, ...(mode ? { sessionMode: mode } : {}), ...(intent !== 'next_turn' && pin.pin?.nativeTurnId ? { expectedNativeTurnId: pin.pin.nativeTurnId } : {}),
      ...(files.attachments.length ? { attachments: [...files.attachments] } : {}) })
  }
  const visible = older ?? state, receipts = state?.receipts ?? []
  const retained = useRetainedInputs(target, revoke)
  const messages = visible?.messages.filter((message, index, all) => !(index > 0 && message.role === 'assistant'
    && all[index - 1]!.role === 'assistant' && sameStructuredResult(all[index - 1]!.content, message.content))) ?? []
  // Messages you sent that wait outside the native transcript sit in time order, before the reply they asked for.
  const placed = retained.items.map(input => {
    const consultationId = receipts.find(receipt => receipt.id === input.receiptId)?.consultationId
    const reply = consultationId ? messages.findIndex(message => message.provenance.kind === 'consultation'
      && message.provenance.binding.consultationId === consultationId) : -1
    return { input, before: reply >= 0 ? reply
      : messages.findIndex(message => !!message.createdAt && message.createdAt > input.createdAt) }
  })
  const retainedProps = { target, receipts, onDenied: revoke, onRecover: props.onRecover, controlsReason, onOpenGroup: props.onOpenGroup, onOpenContinuation: props.onOpenContinuation,
    onCancel: delivery.pendingControl ? undefined : (receipt: ChatDeliveryReceipt) => delivery.cancel(receipt.id), onRefresh: delivery.refresh, state: retained }
  const retainedAt = (index: number) => placed.filter(item => item.before === index).map(({ input }) =>
    <RetainedInput key={input.receiptId} input={input} {...retainedProps} />)
  // A finished execution takes no new turn here; its Agent chat continues the same session with its history.
  const closed = state?.state === 'idle' && target.kind === 'workflow_execution' && !presentation.capabilities.queue
  // Messages still in doubt keep their status and recovery controls in view before handing over to that chat.
  const unsettled = !!delivery.pending || !!delivery.pendingControl || retained.items.length > 0
    || receipts.some(receipt => receipt.state === 'queued' || receipt.state === 'unknown')
  if (denied || delivery.denied) return <Alert tone="warning" title="Chat access unavailable"><Button onClick={() => {
    detailAbort.current = new AbortController(); setDenied(false); delivery.refresh()
  }}>Refresh access</Button></Alert>
  if (closed && !unsettled && props.followUp) return <>{delivery.feedback ? <p role="alert">{delivery.feedback}</p> : null}{props.followUp}</>
  return <section className="agent-conversation" aria-label="Selected execution chat">
    {/* The Board's chat tab already names the Run attempt above this panel. */}
    <header className="agent-chat-identity"><h2>{props.name}</h2></header>
    {delivery.query.isPending ? <LoadingState label="Loading selected execution…" rows={2} /> : null}
    {delivery.query.isError ? <p role="alert">Could not refresh this execution. <Button onClick={delivery.refresh}>Retry</Button></p> : null}
    <ConversationViewport storageKey={draftKey} revision={JSON.stringify([visible?.revision, visible?.messages, retained.items.length])}>{onBrowse => <>
      {visible?.hasMore ? <Button loading={history.isPending} disabled={!stream.historyReady} onClick={() => { onBrowse(); history.mutate() }}>Load earlier messages</Button> : null}
      {!stream.historyReady ? <p role="status">Refreshing the message window. <Button onClick={stream.refresh}>Refresh message window</Button></p> : null}
      {history.isError ? <p role="alert">Earlier messages could not be loaded.</p> : null}
      {older ? <Button onClick={() => { setOlder(undefined); delivery.refresh() }}>Back to latest messages</Button> : null}
      <RetainedInputsStatus state={retained} />
      {messages.map((message, index) => <Fragment key={message.id}>{retainedAt(index)}<ExecutionNativeMessage message={message} name={props.name}
        target={target} source={props.source} onBrowse={onBrowse} onDenied={revoke} /></Fragment>)}
      {retainedAt(-1)}
    </>}</ConversationViewport>
    <ChatDeliveryReceipts receipts={receipts.filter(receipt => receipt.state === 'queued' || receipt.state === 'unknown')} controlsReason={controlsReason} onCancel={delivery.pendingControl ? undefined : receipt => delivery.cancel(receipt.id)}
      onRefresh={delivery.refresh} onOpenContinuation={props.onOpenContinuation} />
    {pin.stale ? <Button onClick={pin.refresh}>Refresh target</Button> : null}
    {delivery.feedback ? <p role="alert">{delivery.feedback}</p> : null}
    {delivery.pending ? <p role="status">Delivery is not confirmed. <Button onClick={() => void delivery.reconcile()}>Check status</Button>
      <Button onClick={() => void delivery.reconcile(true)}>Retry original message</Button></p> : null}
    {delivery.pendingControl ? <p role="status">Control is not confirmed. <Button disabled={delivery.busy || !delivery.online}
      onClick={delivery.retryControl}>Retry original control</Button></p> : null}
    {closed ? null : <AgentChatComposer name={props.name} draftKey={draftKey} inputRef={inputRef} disabled={false} pending={delivery.busy || !!delivery.pending}
      reason={reason} controlPending={false} hasAttachments={!!props.attachments?.hasAttachments} attachmentControl={props.attachmentControl}
      sessionCommands={false} controlReason={sessionReason}
      onSubmit={submit} onStop={delivery.stop} canStop={false}
      deliveryActions={<ChatDeliveryActions presentation={presentation} intent={intent} onIntentChange={setIntent} onSubmit={() => submit()}
        controlsReason={controlsReason}
        reason={reason} pending={delivery.busy || !!delivery.pending} empty={!draft.trim() && !props.attachments?.hasAttachments || props.attachments?.hasBlockingAttachments}
        onStop={!delivery.pendingControl && presentation.state === 'active' ? delivery.stop : undefined}
        onCancelQueued={delivery.pendingControl ? undefined : delivery.cancelAll} queueCount={receipts.filter(receipt => receipt.state === 'queued').length} />} />}
  </section>
}

import type { AgentChatState, AgentChatTurn, SendAgentChatMessageRequest } from '@foreman-code/contracts/agent-chat'
import type { MessageAttachmentRef } from '@foreman-code/contracts/files'
import { parseSessionCommand, type ChatDeliveryReceipt, type InteractionResponseValue, type Message, type SessionMode } from '@foreman-code/contracts'
import { X } from 'lucide-react'
import { createContext, memo, useContext, useEffect, useRef, type ReactNode } from 'react'
import { Button, IconButton, Tooltip } from '../../../shared/ui/nocturne'
import { ChatMessageFiles, ChatDecisionReceipts, HistoryWindowNotice, useChatTurnCompleted, agentChatContextKey, approvalReplyAvailable, mergeChatMessages, applyCanonicalActivityItems } from '../../chat-core'
import { OperatorApprovalCard } from '../../operator-chat/OperatorApprovalCard'
import { ConversationViewport } from '../ConversationViewport'
import { RunTranscript } from './RunTranscript'
import { useExecutionActivity } from './executionActivity'
import { AgentChatMessage } from './AgentChatMessage'
import { AgentChatActivity } from './AgentChatActivity'
import { ChatDeliveryState } from './ChatDeliveryState'
import { RetainedAgentCommand } from './RetainedAgentCommand'
import { confirmedCommandReceipt } from './commandRecords'
import { placeChatActivities } from './activityPlacement'
import { commandMayHaveBeenAccepted, type AgentChatCommandRecord, type useAgentChat } from './useAgentChat'

type TranscriptProps = {
  state: AgentChatState; name: string; commands: AgentChatCommandRecord[]; history: ReturnType<typeof useAgentChat>['history']
  storageKey?: string; children?: ReactNode
  readOnly?: boolean; cancelReason?: string; responseReason?: string; resendReason?: string; controlResendReason?: string
  onRefresh?(): void; refreshing?: boolean
  onDenied?(error: Error): void
  onReceipt?(receipt: ChatDeliveryReceipt): void
  onCancel(requestId: string): void; onRespond(optionId: string, response?: InteractionResponseValue): void
  onSendAgain(content: string, attachments?: MessageAttachmentRef[], mode?: SessionMode): void
}

export function AgentChatTranscript({
  state, name, commands, history, readOnly = false, cancelReason, responseReason, resendReason, controlResendReason,
  onRefresh, refreshing, onCancel, onRespond, onSendAgain, onDenied, onReceipt, children, storageKey,
}: TranscriptProps) {
  const id = state.conversation?.id
  const turnCompleted = useChatTurnCompleted(id, state.activeTurn?.requestId)
  const chatResponding = !turnCompleted && !state.pendingInteraction
    && ['creating', 'active', 'interrupting'].includes(state.sessionState)
  const executionResponding = state.sourceTranscript
    && ['starting', 'running'].includes(state.sourceTranscript.state)
  const feed = useExecutionActivity(state.context)
  const sourceRevision = state.sourceTranscript?.revision
  const refetchFeed = feed.query.refetch
  // A newer execution state seen by the chat read pulls its activity now instead of on the next tick.
  const seenRevision = useRef(sourceRevision)
  useEffect(() => {
    if (seenRevision.current === sourceRevision) return
    seenRevision.current = sourceRevision
    void refetchFeed()
  }, [sourceRevision, refetchFeed])
  const resendUnavailable = (content: string) => {
    const command = parseSessionCommand(content)
    return command.kind === 'compact' || command.kind === 'mode' ? controlResendReason : resendReason
  }
  const messages = mergeChatMessages(
    ...[...(history.data?.pages.flatMap(batch => batch.pages) ?? [])].reverse().map(page => page.messages),
    state.messages,
  ).filter(message => message.activityChannel !== 'reasoning')
  const retainedTurns = commands.flatMap(record => {
    const turn = confirmedCommandReceipt(record, state)
      ?? (record.result?.conversationId === id ? record.result?.turn : undefined)
    return turn && !state.turns.some(current => current.requestId === turn.requestId) ? [turn] : []
  })
  const turns = [...state.turns, ...new Map(retainedTurns.map(turn => [turn.requestId, turn])).values()]
  const receipts = new Map(turns.map(turn => [turn.messageId, turn]))
  const orphaned = turns.filter(turn => !messages.some(message => message.id === turn.messageId))
  const unresolved = commands.filter(record => record.command?.kind === 'send'
    && (record.status === 'pending' || record.status === 'error')
    && !confirmedCommandReceipt(record, state)
    && !turns.some(turn => record.command?.kind === 'send' && turn.requestId === record.command.input.requestId))
  const activities = applyCanonicalActivityItems(state.activities, state.activitySnapshot).filter(entry => entry.kind !== 'thinking')
  const placement = placeChatActivities(messages, activities, state.activeTurn?.requestId)
  const revision = JSON.stringify([feed.query.data?.cursor, feed.query.data?.items.length, messages, state.turns, activities,
    state.pendingInteraction, unresolved.map(record => [record.command, record.status])])
  const originalCommand = (turn: AgentChatTurn) => commands.find(record => record.command?.kind === 'send'
    && record.command.input.requestId === turn.requestId)?.command
  const initialDelivery = (turn: AgentChatTurn) => commands.find(record => record.result?.turn?.requestId === turn.requestId)?.result?.turn?.delivery
  return <MessageActionsContext.Provider value={{ readOnly, cancelReason, resendReason, controlResendReason,
    onRefresh, refreshing, onCancel, onSendAgain }}><ConversationViewport revision={revision} storageKey={storageKey ?? `${agentChatContextKey(state.context)}:${id ?? 'native'}`}>{onBrowse => <>
    {children}
    {history.hasGap ? <HistoryWindowNotice pending={history.isFetching && !history.isRefetching}
      onReload={() => { onBrowse(); void history.reloadNearer() }} /> : null}
    {id && (state.hasEarlierMessages && !history.data || history.hasNextPage) ? <Button size="sm" variant="ghost"
      disabled={history.isFetching && !history.isRefetching} onClick={() => { onBrowse(); void history.fetchNextPage() }}>Load earlier messages</Button> : null}
    {history.isError ? <p role="alert">History unavailable. <Button size="sm" disabled={history.isFetching && !history.isRefetching}
      onClick={() => { onBrowse(); void history.fetchNextPage() }}>Retry history</Button></p> : null}
    {state.context.runId ? <RunTranscript feed={feed} name={name} onBrowse={onBrowse} /> : null}
    {(!state.sourceTranscript || state.conversation) ? <ol className="agent-chat-messages" aria-label="Conversation history">
      {[
        ...messages.flatMap(message => [
          ...placement.rows.filter(row => row.beforeMessageId === message.id).map(({ entry }) =>
            <li key={`activity:${entry.requestId}:${entry.id}`}>
              <AgentChatActivity entry={entry} onBrowse={onBrowse} />
            </li>),
          <li key={`message:${message.id}`}>
            <TranscriptMessage message={message} name={name} workspaceId={state.context.workspaceId}
              turn={message.role === 'user' ? receipts.get(message.id) : undefined}
              original={message.role === 'user' && receipts.has(message.id) ? originalCommand(receipts.get(message.id)!) : undefined}
              initialDelivery={message.role === 'user' && receipts.has(message.id) ? initialDelivery(receipts.get(message.id)!) : undefined} />
          </li>,
        ]),
        ...placement.rows.filter(row => row.beforeMessageId === undefined).map(({ entry }) =>
          <li key={`activity:${entry.requestId}:${entry.id}`}><AgentChatActivity entry={entry} onBrowse={onBrowse} /></li>),
      ]}
    </ol> : null}
    {orphaned.length ? <section className="agent-chat-orphaned-turns" aria-label="Messages outside the current history page">
      {orphaned.map(turn => {
        const original = originalCommand(turn)
        return <AgentChatMessage key={turn.requestId} name={name}
          message={{ id: turn.messageId, role: 'user', content: original?.kind === 'send'
            ? original.input.content : 'Message outside this history page', createdAt: turn.createdAt }}
          status={<ChatDeliveryState delivery={turn.delivery} turn={turn} initialDelivery={initialDelivery(turn)} />} actions={<MessageActions turn={turn} original={original} />} />
      })}
    </section> : null}
    {commands.map(record => record.command?.kind === 'send' && record.result?.receipt
      && !turns.some(turn => turn.requestId === record.result!.receipt!.commandId)
      ? <RetainedAgentCommand key={record.result.receipt.id} command={record.command} receipt={record.result.receipt}
        onDenied={onDenied} onReceipt={onReceipt} onSendAgain={onSendAgain} readOnly={readOnly} resendReason={resendUnavailable(record.command.input.content)} /> : null)}
    {unresolved.map(record => {
      if (record.command?.kind !== 'send') return null
      const input = record.command.input
      let delivery: AgentChatTurn['delivery'] = 'submitting'
      if (record.status === 'error') delivery = commandMayHaveBeenAccepted(record.error) ? 'unknown' : 'failed'
      return <AgentChatMessage key={input.requestId} name={name}
        message={{ id: input.requestId, role: 'user', content: input.content }}
        status={<ChatDeliveryState delivery={delivery} />}
        actions={!readOnly && record.status === 'error' ? <Button size="sm" variant="ghost"
          disabled={!!resendUnavailable(input.content)} title={resendUnavailable(input.content)}
          onClick={() => onSendAgain(input.content, input.attachments, input.sessionMode)}>
          {delivery === 'failed' ? 'Retry' : 'Send again as new message'}
        </Button> : undefined} />
    })}
    {chatResponding || executionResponding ? <div className="agent-chat-typing"
      role="status" aria-label={`${name} is working`}><span /><span /><span /></div> : null}
    {!readOnly && state.pendingInteraction ? <OperatorApprovalCard actor="Agent" interaction={state.pendingInteraction}
      onBrowse={onBrowse} disabled={!!responseReason || !approvalReplyAvailable(state)} onSelect={onRespond} /> : null}
    {onRefresh ? <ChatDecisionReceipts snapshot={state.activitySnapshot} onRefresh={onRefresh} pending={refreshing} /> : null}
  </>}</ConversationViewport></MessageActionsContext.Provider>
}

const MessageActionsContext = createContext<Pick<TranscriptProps,
  'readOnly' | 'cancelReason' | 'resendReason' | 'controlResendReason' | 'onRefresh' | 'refreshing' | 'onCancel' | 'onSendAgain'> | undefined>(undefined)

const TranscriptMessage = memo(function TranscriptMessage({ message, name, workspaceId, turn, original, initialDelivery }: {
  message: Message; name: string; workspaceId: string; turn?: AgentChatTurn
  original?: AgentChatCommandRecord['command']; initialDelivery?: AgentChatTurn['delivery']
}) {
  return <AgentChatMessage message={message} name={name}
    status={turn ? <ChatDeliveryState delivery={turn.delivery} turn={turn} initialDelivery={initialDelivery} /> : undefined}
    actions={turn ? <MessageActions turn={turn} message={message} original={original} /> : undefined}>
    {message.attachments?.length ? <ChatMessageFiles message={message} workspaceId={workspaceId} /> : null}
  </AgentChatMessage>
})

function MessageActions({ turn, message, original }: {
  turn: AgentChatTurn; message?: Message; original?: AgentChatCommandRecord['command']
}) {
  const controls = useContext(MessageActionsContext)
  if (!controls) throw new Error('Message actions require transcript controls')
  const { readOnly, cancelReason, onRefresh, refreshing, onCancel, onSendAgain } = controls
  const resendUnavailable = (content: string) => {
    const command = parseSessionCommand(content)
    return command.kind === 'compact' || command.kind === 'mode' ? controls.controlResendReason : controls.resendReason
  }
  let input: Pick<SendAgentChatMessageRequest, 'content' | 'attachments'> | undefined
  if (original?.kind === 'send') input = original.input
  if (message?.originalInput?.requestId === turn.requestId) input = message.originalInput
  let retry
  if (!readOnly && (turn.delivery === 'failed' || turn.delivery === 'unknown')) {
    if (input) {
      const source = input
      retry = <Button size="sm" variant="ghost" disabled={!!resendUnavailable(source.content)}
        title={resendUnavailable(source.content)} onClick={() => onSendAgain(source.content, source.attachments,
          original?.kind === 'send' ? original.input.sessionMode : undefined)}>
        {turn.delivery === 'failed' ? 'Retry' : 'Send again as new message'}
      </Button>
    } else if (onRefresh) {
      retry = <Button size="sm" variant="ghost" disabled={refreshing}
        onClick={onRefresh}>Read original send inputs</Button>
    }
  }
  return <>
    {!readOnly && turn.delivery === 'queued' ? <Tooltip content={cancelReason ?? 'Cancel queued message'}>
      <IconButton size="sm" variant="ghost" label="Cancel queued message" disabled={!!cancelReason}
        onClick={() => onCancel(turn.requestId)}><X size={12} aria-hidden="true" /></IconButton>
    </Tooltip> : null}
    {retry}
  </>
}

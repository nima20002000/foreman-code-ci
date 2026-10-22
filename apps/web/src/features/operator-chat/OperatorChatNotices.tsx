import { InfoHint } from '../../shared/ui/InfoHint'
import type { Dispatch, SetStateAction } from 'react'
import type { OperatorConversationState } from '@foreman-code/contracts'
import { Alert, Button, EmptyState, Icon, LoadingState } from '../../shared/ui/nocturne'
import { isApiRestartError } from '../../shared/api/client'
import { identityEpoch } from '../../shared/api/protectedChatStorage'
import { ChatNotice } from '../conversations/ChatNotice'
import { OperatorSetupNotice } from './OperatorSetupNotice'
import { useOperatorChatStore } from './operatorChatStore'
import type { AppRequest } from './operatorChatShared'
import type { useOperatorChatReadback } from './useOperatorChatReadback'
import type { useOperatorConversationMutations } from './useOperatorConversationMutations'
import type { useOperatorCreateConversation } from './useOperatorCreateConversation'
import type { useOperatorSetupState } from './useOperatorSetupState'

type HandoffNotice = { id: string; epoch: string } | undefined

/** Status messages, errors and the empty/loading states above the conversation. */
export function OperatorChatNotices({ handoffNotice, setHandoffNotice, recoveredSelection, missingSelection, shownSetup, remove, restore,
  create, request, accessDenied, createConversation, selectedId, selected, conversation, reconnect }: {
  handoffNotice: HandoffNotice
  setHandoffNotice: Dispatch<SetStateAction<HandoffNotice>>
  recoveredSelection: boolean
  missingSelection: boolean
  shownSetup: ReturnType<typeof useOperatorSetupState>['shownSetup']
  remove: ReturnType<typeof useOperatorConversationMutations>['remove']
  restore: ReturnType<typeof useOperatorConversationMutations>['restore']
  create: ReturnType<typeof useOperatorCreateConversation>['create']
  request: AppRequest | undefined
  accessDenied: boolean
  createConversation: (options?: { retry?: boolean }) => Promise<void>
  selectedId: string | undefined
  selected: ReturnType<typeof useOperatorChatReadback>['selected']
  conversation: OperatorConversationState | undefined
  reconnect: 'reconnecting' | 'down' | undefined
}) {
  const select = useOperatorChatStore((state) => state.select)
  return <>
    {handoffNotice && handoffNotice.epoch === identityEpoch() ? <ChatNotice tone="info" title="Your continued chat is ready."
      action={<Button size="sm" variant="ghost" onClick={() => { select(handoffNotice.id); setHandoffNotice(undefined) }}>Open continued chat</Button>} /> : null}
    {recoveredSelection ? <ChatNotice title="The previous conversation is no longer available.">Start a new chat. Any saved draft or pending message has been kept on this device.</ChatNotice> : null}
    {!missingSelection && !reconnect ? <OperatorSetupNotice data={shownSetup.data} checking={shownSetup.isFetching} failed={shownSetup.isError && !isApiRestartError(shownSetup.error)} error={shownSetup.error} onRetry={() => void shownSetup.refetch()} /> : null}
    {remove.error instanceof Error ? <Alert live tone="danger" title="Chat could not be deleted">{remove.error.message}</Alert> : null}
    {restore.error instanceof Error ? <Alert live tone="danger" title="Chat could not be restored">{restore.error.message}</Alert> : null}
    {create.error instanceof Error ? <Alert live tone="danger" title="Conversation could not be created"
      action={request && create.variables?.request?.id === request.id
        ? <Button size="sm" disabled={create.isPending || accessDenied} onClick={() => create.reset()}>Retry requested chat</Button>
        : <Button size="sm" disabled={create.isPending || accessDenied}
          onClick={() => void createConversation({ retry: true })}>Retry new chat</Button>}>
      {create.error.message}
      {request && create.variables?.request?.id === request.id ? <p>{request.content}</p> : null}
    </Alert> : null}
    {/* One state at a time: offline, then reconnecting, then the start screen or the loading conversation. */}
    {reconnect === 'down' ? <div className="operator-chat-start" role="alert"><EmptyState icon="chat" title="Operator is offline"
      description="Your draft is kept. It reconnects by itself when the app is back."
      action={<Button variant="primary" onClick={() => { void selected.refetch(); void shownSetup.refetch() }}>Retry now</Button>} /></div>
      : reconnect && (conversation || !selectedId) ? <ChatNotice tone="info" title="Reconnecting…" />
      : reconnect && !accessDenied ? <LoadingState label="Reconnecting…" rows={4} /> : null}
    {!selectedId && !accessDenied && reconnect !== 'down' ? <div className="operator-chat-start"><EmptyState icon="chat" title="Chat with Operator"
      titleHint={<InfoHint label="Chat with Operator">Ask about your workspaces and workflows, or describe a change you need.</InfoHint>}
      action={<Button variant="primary" leading={<Icon name="plus" size={15} />} onClick={() => void createConversation({ retry: create.isError })}
        disabled={create.isPending || Boolean(reconnect)} loading={create.isPending} loadingLabel="Starting…">Start chat</Button>} /></div> : null}
    {!reconnect && selectedId && !conversation && selected.isPending && !accessDenied ? <LoadingState label="Loading conversation…" rows={4} /> : null}
    {!reconnect && selectedId && !conversation && selected.isError && !accessDenied && !missingSelection
      ? <Alert live tone="danger" title="This chat could not be loaded"
        action={<Button size="sm" loading={selected.isFetching} onClick={() => void selected.refetch()}>Try again</Button>}>Your draft is kept.</Alert> : null}
  </>
}

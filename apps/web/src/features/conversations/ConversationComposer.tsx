import { parseSessionCommand, type SessionMode } from '@foreman-code/contracts'
import { useComposerDraft } from './useComposerDraft'
import { useSessionCommandSubmit } from './sessionControls/useSessionCommandSubmit'
import type { ComposerSessionControls } from '../chat-core'
import { useRef, type ReactNode, type RefObject } from 'react'
import { MessageComposer } from '../../shared/ui/nocturne'

export interface ConversationComposerProps {
  conversationId: string
  /** Disable both editing and submission. */
  disabled?: boolean
  /** Block submission without locking the draft. */
  sendDisabled?: boolean
  /** Existing callers keep their original in-flight editing behavior. */
  allowEditingWhileSending?: boolean
  isSending?: boolean
  attachmentControl?: ReactNode
  hasAttachments?: boolean
  error?: string
  sendLabel?: string
  maxLength?: number
  inputRef?: RefObject<HTMLTextAreaElement | null>
  sessionControls?: ComposerSessionControls
  onSubmit: (content: string, mode?: SessionMode) => void
}

/** A local draft composer; it never sends anything without its parent callback. */
export function ConversationComposer({
  conversationId,
  disabled = false,
  sendDisabled = false,
  allowEditingWhileSending = false,
  isSending = false,
  attachmentControl,
  hasAttachments = false,
  error,
  sendLabel = 'Send message',
  maxLength,
  inputRef,
  onSubmit,
  sessionControls,
}: ConversationComposerProps) {
  const localRef = useRef<HTMLTextAreaElement>(null)
  const field = inputRef ?? localRef
  const commands = useSessionCommandSubmit({ conversationId, sessionControls, inputRef: field,
    onSubmit: (content, mode) => { if (mode) onSubmit(content.trim(), mode); else onSubmit(content.trim()) } })
  const { draft, command: parsed, menu, change } = useComposerDraft(conversationId, content => { void submit(content) }, {
    onEdit: commands.resetError, onComplete: commands.resetError,
  })
  const commandOnly = parsed.kind === 'compact' || parsed.kind === 'mode'
  function submit(content: string) {
    const command = parseSessionCommand(content)
    const controlOnly = command.kind === 'compact' || command.kind === 'mode'
    const pending = controlOnly ? sessionControls?.mutation.isPending : isSending
    if (disabled || pending || (!controlOnly && sendDisabled) || content.length > (maxLength ?? 16000)) return
    return commands.submit(content)
  }
  return (
    <MessageComposer
      footerControl={attachmentControl}
      commandMenu={menu.menu}
      commandInputProps={menu.inputProps}
      onInputKeyDown={menu.onKeyDown}
      hasAttachments={hasAttachments}
      formLabel="Conversation composer"
      label="Message"
      placeholder="Write a message for this agent"
      sendLabel={sendLabel}
      maxLength={maxLength}
      inputRef={field}
      value={draft}
      onValueChange={change}
      onSend={(content) => { void submit(content) }}
      pending={commandOnly ? sessionControls?.mutation.isPending : isSending}
      disabled={disabled || (isSending && !allowEditingWhileSending)}
      sendDisabled={commandOnly ? sessionControls?.mutation.isPending : sendDisabled}
      error={commands.error ?? (error ? `Message could not be sent: ${error}` : undefined)}
    />
  )
}

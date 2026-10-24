import { useId, useLayoutEffect, useRef, type ReactNode } from 'react'
import { parseSessionCommand, type SessionMode } from '@foreman-code/contracts'
import { Icon, IconButton } from '../../shared/ui/nocturne'
import { useComposerDraft, useSessionCommandSubmit } from '../conversations'
import type { useFileDrop } from '../../shared/ui/useFileDrop'
import { ChatPrimaryActions, type ComposerSessionControls } from '../chat-core'
import '../conversations/chatAttachments.css'

export function OperatorComposer({ conversationId, context, attachmentControl, deliveryControl, fileDropProps, hasAttachments = false,
  sendDisabled = false, isSending = false, onSubmit, onNewChat, onCancel, sessionControls }: {
  conversationId: string; context?: ReactNode; attachmentControl?: ReactNode; deliveryControl?: ReactNode; hasAttachments?: boolean;
  sendDisabled?: boolean; isSending?: boolean; sessionControls?: ComposerSessionControls;
  fileDropProps?: ReturnType<typeof useFileDrop>['dropTargetProps'];
  onSubmit(content: string, mode?: SessionMode): void; onNewChat(): void; onCancel?: () => void;
}) {
  const input = useRef<HTMLTextAreaElement>(null)
  const id = useId()
  const commands = useSessionCommandSubmit({ conversationId, sessionControls, onSubmit, onNewChat })
  const { draft: value, command, menu, change } = useComposerDraft(conversationId, content => { void send(content) }, {
    allowNew: true, onEdit: commands.resetError,
  })
  const commandOnly = command.kind === 'compact' || command.kind === 'mode'
  const isNew = command.kind === 'new'
  const pending = commandOnly ? sessionControls?.mutation.isPending : isSending
  const cannotSend = (!isNew && (pending || (!commandOnly && sendDisabled))) || (!value.trim() && !hasAttachments)
  useLayoutEffect(() => {
    if (!input.current) return
    input.current.style.height = '0px'
    input.current.style.height = `${Math.min(144, Math.max(36, input.current.scrollHeight))}px`
  }, [value])
  useLayoutEffect(() => { input.current?.focus() }, [conversationId])
  async function send(content = value.trim()) {
    const parsed = parseSessionCommand(content)
    const controlOnly = parsed.kind === 'compact' || parsed.kind === 'mode'
    const blocked = controlOnly ? sessionControls?.mutation.isPending : isSending || sendDisabled
    if (parsed.kind !== 'new' && (blocked || (!content.trim() && !hasAttachments))) return
    await commands.submit(content)
  }
  return <><form className="operator-composer" aria-label="Conversation composer" {...fileDropProps}
    onSubmit={event => { event.preventDefault(); void send() }}>
    {menu.menu}
    <label htmlFor={id} className="n-sr-only">Message</label>
    {/* One compact block: attach, message and send share a row; agent settings sit below the box.
        Attachment chips wrap above the input row. */}
    <div className="operator-composer-input">
      {attachmentControl}
      {/* eslint-disable-next-line no-restricted-syntax -- combobox textarea uses the shared slash menu. */}
      <textarea ref={input} id={id} rows={1} value={value} maxLength={16000} placeholder="Message the operator…" {...menu.inputProps}
        onChange={event => change(event.target.value)}
        onKeyDown={event => {
          if (event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229 || menu.onKeyDown(event)) return
          if (event.key === 'Enter' && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
            event.preventDefault(); void send()
          }
        }} />
      <div className="operator-composer-actions">
        <ChatPrimaryActions appearance="icon" stopLabel="Stop response" {...(onCancel ? { onStop: onCancel } : {})}>
          <IconButton label="Send message" type="submit" disabled={cannotSend} className="operator-composer-send" loading={pending}><Icon name="arrow" className="operator-send-arrow" size={17} /></IconButton>
        </ChatPrimaryActions>
      </div>
    </div>
    {deliveryControl ? <div className="operator-composer-delivery">{deliveryControl}</div> : null}
    {commands.error ? <p role="alert">{commands.error}</p> : null}
  </form>
  {/* Agent settings sit below the composer box, not inside it. */}
  <div className="operator-composer-options">
    <div className="operator-composer-model">{context}</div>
  </div></>
}

import { useState, type RefObject } from 'react'
import { parseSessionCommand, type SessionMode } from '@foreman-code/contracts'
import { errorMessage } from '../../../shared/errorMessage'
import type { ComposerSessionControls } from '../../chat-core'

/** Native commands share dispatch and receipt feedback; message admission stays with the caller. */
export function useSessionCommandSubmit({ conversationId, sessionControls, onSubmit, onNewChat, inputRef }: {
  conversationId: string
  sessionControls?: ComposerSessionControls
  onSubmit(content: string, mode?: SessionMode): void
  onNewChat?(): void
  inputRef?: RefObject<HTMLTextAreaElement | null>
}) {
  const [error, setError] = useState<{ conversationId: string; content: string; message: string }>()
  const resetError = () => setError(undefined)
  const submit = async (content: string) => {
    const command = parseSessionCommand(content)
    resetError()
    try {
      if (command.kind === 'invalid') throw new Error(command.message)
      if (command.kind === 'compact' || command.kind === 'mode') {
        if (!sessionControls) throw new Error('Native controls are unavailable for this conversation.')
        await sessionControls.command(content, conversationId)
      } else if (command.kind === 'new') {
        if (!onNewChat) throw new Error('/new is available in Operator chat.')
        onNewChat()
      } else if (command.kind === 'plan-task') onSubmit(content, 'plan')
      else onSubmit(content)
    } catch (failure) {
      setError({ conversationId, content,
        message: errorMessage(failure, 'The native command could not be confirmed.') })
    }
    inputRef?.current?.focus({ preventScroll: true })
  }
  const feedback = sessionControls?.commandFeedback
  const compaction = feedback?.draft.key === conversationId && feedback.draft.content === error?.content
    ? feedback.compaction : undefined
  const recovered = !!compaction && compaction.status !== 'failed'
  return { submit, resetError, error: error?.conversationId === conversationId && !recovered
    ? compaction?.message ?? error.message : undefined }
}

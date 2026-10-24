import { parseSessionCommand } from '@foreman-code/contracts'
import { useConversationDraftStore } from './conversationDraftStore'
import { useSlashCommandMenu } from './sessionControls/useSlashCommandMenu'

/** Shared draft and slash-menu interactions; each composer retains its submission and presentation rules. */
export function useComposerDraft(draftKey: string, submit: (content: string) => void, {
  allowNew = false, sessionCommands = true, onEdit, onComplete,
}: { allowNew?: boolean; sessionCommands?: boolean; onEdit?(): void; onComplete?(): void } = {}) {
  const draft = useConversationDraftStore(store => store.drafts[draftKey] ?? '')
  const setDraft = useConversationDraftStore(store => store.setDraft)
  const menu = useSlashCommandMenu(draft, value => {
    setDraft(draftKey, value)
    onComplete?.()
  }, submit, allowNew, sessionCommands)
  const change = (value: string) => {
    setDraft(draftKey, value)
    menu.reset()
    onEdit?.()
  }
  return { draft, command: parseSessionCommand(draft), menu, change }
}

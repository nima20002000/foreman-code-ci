import type { PropsWithChildren } from 'react'
import { Button, Dialog } from '../../shared/ui/nocturne'
import { useOperatorChatStore } from './operatorChatStore'
import { OperatorChatVisibilityContext } from './visibilityContext'

/** The saved flag stays unchanged when a user explicitly opens a hidden chat for a handoff. */
export function OperatorChatVisibilityProvider({ enabled, canShow = true, children }: PropsWithChildren<{ enabled: boolean; canShow?: boolean }>) {
  const request = useOperatorChatStore(state => state.request)
  const shown = useOperatorChatStore(state => state.showHiddenChat)
  const visible = enabled || canShow && shown
  const cancel = () => {
    if (request) useOperatorChatStore.getState().takeRequest(request.id)
    useOperatorChatStore.getState().setOpen(false)
  }
  return <OperatorChatVisibilityContext value={visible}>{children}
    <Dialog open={!visible && canShow && Boolean(request)} title="Operator chat is hidden" size="sm"
      description="Show it for this request. Your saved visibility preference stays unchanged."
      onOpenChange={open => { if (!open) cancel() }}
      footer={<Button onClick={() => useOperatorChatStore.setState({ showHiddenChat: true })}>Show Operator chat</Button>}>
      <p>{request?.content}</p>
    </Dialog>
  </OperatorChatVisibilityContext>
}

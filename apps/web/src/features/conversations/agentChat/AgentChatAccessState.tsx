import { useEffect, useRef, type ReactNode } from 'react'
import { isApiAccessError } from '../../../shared/api/accessError'
import { Alert, Button, LoadingState } from '../../../shared/ui/nocturne'
import { ConversationViewport } from '../ConversationViewport'

/** An unreadable permission endpoint cannot authorize history, but local drafts remain editable. */
export function AgentChatAccessState({ header, pending, error, denial, refresh }: {
  header: ReactNode; pending: boolean; error: Error | null; denial?: Error; refresh(): void
}) {
  // A failed check that is not a denial (e.g. the app restarting) is retried quietly; the draft stays in its store.
  const reconnecting = !denial && !!error && !isApiAccessError(error)
  const retry = useRef(refresh)
  retry.current = refresh
  useEffect(() => {
    if (!reconnecting) return
    const timer = setInterval(() => retry.current(), 3_000)
    return () => clearInterval(timer)
  }, [reconnecting])
  return <div className="agent-conversation">{header}<ConversationViewport revision="access">{() => pending && !denial
    ? <LoadingState label="Checking Agent chat access…" rows={1} /> : reconnecting
    ? <LoadingState label="Reconnecting…" rows={1} /> : <Alert tone="warning" title="Agent chat access unavailable" live>
    <p>{denial?.message ?? error?.message ?? 'Your access does not allow reading chat for this Agent and Run.'}</p>
    <Button size="sm" onClick={refresh}>Refresh access</Button>
  </Alert>}</ConversationViewport></div>
}

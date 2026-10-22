import { useEffect, useRef } from 'react'
import { LoadingState } from '../../../shared/ui/nocturne'

/** While the chat loads or reconnects, a quiet status only; the draft stays in its store and returns with the composer. */
export function UnavailableChatDraft({ pending, onRefresh }: { draftKey?: string; pending: boolean; onRefresh(): void }) {
  const retry = useRef(onRefresh)
  retry.current = onRefresh
  useEffect(() => {
    if (pending) return
    const timer = setInterval(() => retry.current(), 3_000)
    return () => clearInterval(timer)
  }, [pending])
  return <LoadingState label={pending ? 'Loading this conversation…' : 'Reconnecting…'} rows={1} />
}

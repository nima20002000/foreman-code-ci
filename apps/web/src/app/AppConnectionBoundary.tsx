import { type ReactNode } from 'react'
import { useQueryClient } from '@tanstack/react-query'
import { useLocalHumanAccessQuery } from '../shared/api/settingsExperience'
import { ApiError } from '../shared/api/client'
import { Button } from '../shared/ui/nocturne'
import { isTransientReadError, useBlockingReadError } from '../shared/api/readFailure'
import { reconnectingMessage, retryApiReads, useApiReconnect } from '../shared/api/reconnect'
import { useManualRefetch } from '../shared/api/useManualRefetch'
import { RuntimeInstanceBoundary } from './RuntimeInstanceBoundary'
import { ChatAttachmentBoundary } from '../features/conversations'
import { useHeld } from '../shared/ui/useHeld'
import './runtimeBoundary.css'

export function AppConnectionBoundary({ children }: { children: ReactNode }) {
  const access = useLocalHumanAccessQuery()
  const reconnecting = useApiReconnect()
  const client = useQueryClient()
  // Try again reads every failed read, not only access: the banner shows while any of them is down.
  const retry = useManualRefetch(() => Promise.all([retryApiReads(client), access.refetch()]))
  const blocked = useBlockingReadError(access)
  const denied = ApiError.is(access.error) && [401, 403].includes(access.error.status ?? 0)
  const retryableLookup = isTransientReadError(access.error)
  const interrupted = useHeld(reconnecting || retryableLookup)
  const restarting = useHeld(reconnecting)
  const unavailable = <main className="runtime-screen"><section className="runtime-card" role="alert">
    <h1>{denied ? 'Access unavailable' : 'Cannot reach the server'}</h1>
    <p>{access.error?.message ?? 'Check the local API connection, then try again.'}</p>
    <Button variant="primary" onClick={() => void access.refetch()}>Try again</Button>
  </section></main>
  // Held like the banner: each retry of a read without data clears its error, which must not flash "Connecting…".
  if (!blocked && restarting && !access.data) return <main className="runtime-screen">
    <section className="runtime-card" role="status">
      <p>{reconnectingMessage}</p>
      <Button variant="primary" onClick={() => void retry.refetch()}>Try again</Button>
    </section>
  </main>
  if (blocked || access.isError && !access.data) return unavailable
  if (!access.data) return <main className="runtime-screen" role="status">Connecting to the local app…</main>
  return <RuntimeInstanceBoundary><ChatAttachmentBoundary>
    {access.isError && !retryableLookup ? unavailable : <>
      {interrupted ? <aside className="runtime-reconnecting" aria-label="Server connection" role="alert">
        <span>{reconnectingMessage}</span>
        <Button size="sm" data-skip-folder-blur onClick={() => void retry.refetch()}
          loading={retry.pending}>Try again</Button>
      </aside> : null}
      {children}
    </>}
  </ChatAttachmentBoundary></RuntimeInstanceBoundary>
}

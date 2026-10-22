import { useEffect, useState } from 'react'
import { useQuery, useQueryClient } from '@tanstack/react-query'
import { Button, Dialog } from '../../shared/ui/nocturne'
import { BrowserSessionSchema } from '@foreman-code/contracts/browser-sessions'
import { BrowserTransfers } from '../agent-browser/BrowserTransfers'
import { validateBrowserRead } from '../agent-browser/queries'
import { browserAccessDenied, browserErrorMessage } from '../agent-browser/errors'
import type { BrowserUiPort } from '../agent-browser/types'
import type { BrowserFilesPort } from '../agent-browser/transferTypes'

/** Retained downloads use session history reads only; opening this dialog never starts capture. */
export function BrowserProfileDownloads({ authBoundary, profileId, computerId, profileName, port, files, onClose }: {
  authBoundary: string; profileId: string; computerId: string; profileName: string
  port: BrowserUiPort; files: BrowserFilesPort; onClose(): void
}) {
  const [selected, setSelected] = useState<string | null>(null)
  const [denied, setDenied] = useState(false)
  const queryClient = useQueryClient()
  const sessions = useQuery({ queryKey: ['browser-downloads', authBoundary, profileId, computerId], enabled: !denied,
    queryFn: async ({ signal }) => {
      const values = (await port.listSetupSessions(profileId, computerId, signal)).map(value => BrowserSessionSchema.parse(value))
      if (values.some(value => value.subject || value.setupForProfileId !== profileId || value.computerId !== computerId)) {
        throw new Error('Downloads do not match this profile and computer.')
      }
      return values
    } })
  const read = useQuery({ queryKey: ['browser-downloads', authBoundary, profileId, computerId, selected], enabled: selected !== null && !denied,
    queryFn: async ({ signal }) => {
      const value = validateBrowserRead(await port.readSession(selected!, signal))
      if (value.session.id !== selected || value.session.subject || value.session.setupForProfileId !== profileId
        || value.session.computerId !== computerId) throw new Error('The downloads session changed.')
      return value
    } })
  const error = sessions.error ?? read.error
  useEffect(() => {
    if (browserAccessDenied(error)) { setDenied(true); queryClient.removeQueries({ queryKey: ['browser-downloads', authBoundary] }) }
  }, [error, queryClient, authBoundary])
  const stateLabel = { starting: 'Starting', ready: 'Open', paused: 'Paused', recovering: 'Reconnecting', closed: 'Closed', failed: 'Failed' } as const
  const current = selected ?? (sessions.data?.length === 1 ? sessions.data[0]!.id : null)
  useEffect(() => { if (current && current !== selected) setSelected(current) }, [current, selected])
  return <Dialog open size="md" title={`Downloads · ${profileName}`} description="Files from setup sessions stay until you delete them."
    onOpenChange={open => { if (!open) onClose() }}>
    {denied || browserAccessDenied(error) ? <p role="alert" className="browser-profile-note">Browser files are unavailable right now.</p> : <div className="browser-profile-form">
    {sessions.isPending ? <p role="status" className="browser-profile-note">Loading…</p> : null}
    {error ? <p role="alert" className="browser-profile-note">{browserErrorMessage(error)} <Button size="sm" variant="ghost" onClick={() => {
      void (selected ? read.refetch() : sessions.refetch())
    }}>Retry</Button></p> : null}
    {sessions.data?.length === 0 ? <p className="browser-profile-note">No downloads yet. Files appear here after you download them during setup.</p> : null}
    {sessions.data && sessions.data.length > 1 ? <div className="browser-profile-actions" role="group" aria-label="Setup sessions">{sessions.data.map((session, index) => <Button key={session.id} size="sm"
      variant={session.id === selected ? 'primary' : 'ghost'} aria-pressed={session.id === selected} onClick={() => setSelected(session.id)}>
      Setup {index + 1} · {stateLabel[session.state]}
    </Button>)}</div> : null}
    {selected && read.isPending ? <p role="status" className="browser-profile-note">Loading files…</p> : null}
    {read.data ? read.data.files.length ? <BrowserTransfers port={files} session={read.data.session} downloads={read.data.files}
        onDenied={() => { setDenied(true); queryClient.removeQueries({ queryKey: ['browser-downloads', authBoundary] }) }}
        onChanged={() => { void read.refetch() }} /> : <p className="browser-profile-note">No files in this session.</p> : null}
    </div>}
  </Dialog>
}

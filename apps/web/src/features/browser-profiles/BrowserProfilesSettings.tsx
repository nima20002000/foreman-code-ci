import { useEffect, useRef, useState, type ReactNode } from 'react'
import { useMutation, useQueryClient } from '@tanstack/react-query'
import { Button } from '../../shared/ui/nocturne'
import {
  browserAccessDenied, browserErrorMessage, browserRequestUncertain, type BrowserSession, type BrowserUiPort,
  type BrowserFilesPort,
} from '../agent-browser'
import { BrowserProfileDownloads } from './BrowserProfileDownloads'
import { BrowserProfileComputerRows } from './BrowserProfileComputerRows'
import { BrowserProfileForm } from './BrowserProfileForm'
import { BrowserProfileSyncDetails } from './BrowserProfileSyncDetails'
import { browserProfilesKey, useBrowserProfiles } from './queries'
import type { BrowserComputerLabel, BrowserProfile, BrowserProfilesPort } from './types'
import './browserProfiles.css'

type ProfileAction = { commandId: string; run(commandId: string): Promise<void> }

export interface BrowserProfilesSettingsProps {
  visible: boolean
  authBoundary: string
  computers: readonly BrowserComputerLabel[]
  currentComputerId: string
  port: BrowserProfilesPort
  sessionPort: BrowserUiPort
  files: BrowserFilesPort
  onOpenSetup(session: BrowserSession): void
  /** Extra per-computer control, such as Repair browser, shown beside the computer's name. */
  computerAction?(computer: BrowserComputerLabel): ReactNode
}

export function BrowserProfilesSettings(props: BrowserProfilesSettingsProps) {
  if (!props.visible) return null
  return <VisibleBrowserProfiles key={props.authBoundary} {...props} />
}

function VisibleBrowserProfiles({ authBoundary, computers, currentComputerId, port, sessionPort, files, onOpenSetup, computerAction }: BrowserProfilesSettingsProps) {
  const queryClient = useQueryClient()
  const [denied, setDenied] = useState(false)
  const catalog = useBrowserProfiles(port, authBoundary, !denied)
  const [editor, setEditor] = useState<{ profile: BrowserProfile | null; computerId: string } | null>(null)
  const [jobId, setJobId] = useState<string | null>(null)
  const [notice, setNotice] = useState<string | null>(null)
  const [downloads, setDownloads] = useState<{ profile: BrowserProfile; computerId: string } | null>(null)
  const active = useRef(true)
  useEffect(() => { active.current = true; return () => { active.current = false } }, [])
  useEffect(() => {
    if (browserAccessDenied(catalog.error)) {
      setDenied(true); queryClient.removeQueries({ queryKey: browserProfilesKey(authBoundary) })
    }
  }, [catalog.error, authBoundary, queryClient])
  const mutation = useMutation({ mutationFn: (action: ProfileAction) => action.run(action.commandId), retry: false,
    onSuccess: () => { void queryClient.invalidateQueries({ queryKey: browserProfilesKey(authBoundary) }) },
    onError: error => {
      if (active.current && browserAccessDenied(error)) { setDenied(true); queryClient.removeQueries({ queryKey: browserProfilesKey(authBoundary) }) }
    } })
  const unresolved = mutation.isError && browserRequestUncertain(mutation.error)
  const busy = mutation.isPending || unresolved
  const openEditor = (next: { profile: BrowserProfile | null; computerId: string }) => { mutation.reset(); setEditor(next) }
  const act = (run: ProfileAction['run']) => { if (!busy) { setNotice(null); mutation.mutate({ commandId: crypto.randomUUID(), run }) } }
  const retry = () => { if (mutation.variables && !mutation.isPending) mutation.mutate(mutation.variables) }
  const sync = (profileIds?: readonly string[]) => act(async commandId => {
    const receipt = await port.sync(profileIds, commandId)
    if (!active.current) return
    // Policy saves never enter this branch. Only an admitted sync receipt can show Queued.
    setJobId(receipt.id)
    setNotice(`Sync ${receipt.state}`)
  })
  const computerNames = new Map(computers.map(computer => [computer.id, computer.name]))
  const profileNames = new Map(catalog.data?.profiles.map(profile => [profile.id, profile.name]) ?? [])
  const accessDenied = denied || browserAccessDenied(catalog.error)
  return <section className="browser-profiles-settings" aria-label="Browser profiles">
    {accessDenied ? <div className="browser-profile-note"><p role="alert">Browser profiles are unavailable right now.</p>
      <Button size="sm" disabled={catalog.isFetching} onClick={() => {
        void catalog.refetch().then(result => {
          if (active.current && result.isSuccess) { mutation.reset(); setDenied(false) }
        })
      }}>Recheck access</Button></div> : <>
      <div className="browser-profile-toolbar">
        <Button variant="primary" disabled={busy || !catalog.data} onClick={() => openEditor({ profile: null, computerId: currentComputerId })}>Add profile</Button>
        <Button variant="ghost" disabled={busy || !catalog.data?.profiles.length} onClick={() => sync()}>Sync profiles to all computers</Button>
      </div>
      {catalog.isPending ? <div className="browser-profile-computers" aria-busy="true">{[0, 1].map(index => <div key={index} className="browser-profile-computer browser-profile-skeleton" />)}</div> : null}
      {catalog.error ? <p role="alert" className="browser-profile-note">{browserErrorMessage(catalog.error)} <Button size="sm" variant="ghost" onClick={() => { void catalog.refetch() }}>Retry</Button></p> : null}
      {notice ? <p role="status" className="browser-profile-note">{notice}</p> : null}
      {mutation.error && !editor ? <div role="alert" className="browser-profile-note">{browserErrorMessage(mutation.error)} No new operation is confirmed.
        <Button size="sm" disabled={mutation.isPending} onClick={retry}>Check original request</Button></div> : null}
      {catalog.data ? <div className="browser-profile-computers">{computers.map(computer => <section key={computer.id}
        aria-label={`Browser profiles on ${computer.name}`} className="browser-profile-computer">
        <header className="browser-profile-computer-heading">
          <div><h3><span className="browser-profile-dot" data-online={computer.online} aria-hidden="true" />{computer.name}</h3>
            <small>{computer.online ? 'Online' : 'Offline'}{computer.runtimeReady ? ' · Browser ready' : ' · Browser setup needed'}</small></div>
          <div className="browser-profile-actions">
            {computerAction?.(computer)}
            <Button size="sm" variant="ghost" disabled={busy} onClick={() => openEditor({ profile: null, computerId: computer.id })}>Add profile here</Button>
          </div>
        </header>
        {catalog.data!.profiles.length === 0 ? <p className="browser-profile-note">No profiles yet.</p> : null}
        <BrowserProfileComputerRows profiles={catalog.data!.profiles} replicas={catalog.data!.replicas}
          presentReplicas={catalog.data!.presentReplicas}
          pendingReplicas={catalog.data!.pendingReplicas}
          computer={computer} computerNames={computerNames} disabled={busy}
          onOpen={profile => act(async commandId => {
            const session = await port.openSetup(profile.id, computer.id, commandId)
            if (active.current) { onOpenSetup(session); return }
            // The app's close client retains an unconfirmed cleanup and throws; a second notice here would duplicate it.
            await port.closeSetup(session, `retired:${commandId}`)
          })}
          onEdit={profile => openEditor({ profile, computerId: computer.id })}
          onRemove={profile => act(async commandId => {
            const state = await port.remove(profile.id, computer.id, commandId)
            if (!active.current) return
            setNotice(state === 'removed' ? `Removed ${profile.name} from ${computer.name}. Other copies remain; a later explicit sync may add it again.`
              : `Removal queued on ${computer.name}. Waiting for owned browser work to close.`)
          })}
          onPolicy={(profile, replica) => act(async commandId => {
            const saved = await port.setLocalOverride(profile.id, computer.id, !replica.localOverride, commandId)
            if (!active.current) return
            setNotice(saved.localOverride ? 'Local sign-in is excluded from source updates.' : 'Source updates enabled — sync to apply')
          })}
          onDownloads={profile => setDownloads({ profile, computerId: computer.id })}
          onSync={profile => sync([profile.id])} />
      </section>)}</div> : null}
      {jobId ? <BrowserProfileSyncDetails port={port} authBoundary={authBoundary} jobId={jobId}
        computerNames={computerNames} profileNames={profileNames} /> : null}
      {downloads ? <BrowserProfileDownloads key={`${downloads.profile.id}:${downloads.computerId}`} authBoundary={authBoundary}
        profileId={downloads.profile.id} profileName={downloads.profile.name} computerId={downloads.computerId}
        port={sessionPort} files={files} onClose={() => setDownloads(null)} /> : null}
      {editor ? <BrowserProfileForm key={editor.profile?.id ?? editor.computerId} {...editor} computers={computers}
        profiles={catalog.data?.profiles ?? []}
        pending={mutation.isPending} unresolved={unresolved} error={mutation.error ? browserErrorMessage(mutation.error) : null}
        onRetry={retry} onClose={() => { setEditor(null); mutation.reset() }}
        onAddExisting={(profileId, computerId) => act(async commandId => {
          const receipt = await port.addExisting(profileId, computerId, commandId)
          if (!active.current) return
          setEditor(null)
          setNotice(receipt.state === 'ready' ? 'Profile added on this computer.' : receipt.state === 'first_snapshot_pending'
            ? 'Waiting for the first source snapshot. The profile will appear here after it is received and applied.'
            : 'Adding profile on this computer. Waiting for the computer to confirm it is ready.')
        })}
        onSave={(name, computerId, distribution) => act(async commandId => {
          if (editor.profile) await port.update(editor.profile.id, { name, sourceComputerId: computerId, distribution }, commandId)
          else await port.create(name, computerId, distribution, commandId)
          if (!active.current) return
          setEditor(null); setNotice('Profile saved. Open its browser to sign in.')
        })} /> : null}
    </>}
  </section>
}

import { useState } from 'react'
import type { DeviceRegistration } from '@foreman-code/contracts/device-identity'
import { sameDeviceProvisioningTarget, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { COMPUTER_NAME_MAX_LENGTH, computerDisplayName } from '@foreman-code/contracts/computer-activity'
import { useBuildComputers, useUpdateBuildComputer } from '../../shared/api/buildComputers'
import { useComputerActivity, useRenameComputer } from '../../shared/api/computerActivity'
import { UnsavedEditorGuard, useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useCollaborationUISlots } from '../../shared/ui/collaborationSlots'
import { useNavigate, useSearch } from '@tanstack/react-router'
import { Alert, Badge, Button, SettingRow, SettingsSection, Skeleton, Switch, Tabs, TextField } from '../../shared/ui/nocturne'
import type { ComputerSettingsTab } from './computerSettingsTabs'
import { ComputerCards, ComputerSyncPanel } from '../computers'
import { ProviderAccountsSettings } from '../provider-accounts'
import { ComputerPairingRecovery } from './ComputerPairingRecovery'
import { ComputerRevokeButton } from './ComputerRevokeButton'
import { ConnectionSetupStatus } from './DeviceSetupGuide'

function targetOf(mainId: string, registration: DeviceRegistration | undefined): DeviceProvisioningTarget | undefined {
  if (!registration) return { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, keyRevision: null, authorizationRevision: null }
  if (registration.status !== 'paired') return undefined
  return { hostRef: { kind: 'device', mainId, deviceId: registration.deviceId }, applicationInstallationId: registration.workerInstallationId,
    keyRevision: registration.keyRevision, authorizationRevision: registration.authorizationRevision }
}

/** Settings for one computer: its name, builds, sign-ins, maintenance, file sync and browser profiles. */
export function ComputerDetailSettings({ mainId, devices, registration }: {
  mainId: string; devices: DeviceRegistration[]
  /** Absent for the Main PC. */
  registration?: DeviceRegistration | undefined
}) {
  const target = targetOf(mainId, registration)
  const activity = useComputerActivity()
  const slots = useCollaborationUISlots()
  const observed = target ? activity.data?.computers.find(computer => sameDeviceProvisioningTarget(computer.target, target)) : undefined
  const hostRef = registration ? { kind: 'device' as const, deviceId: registration.deviceId } : { kind: 'main' as const }
  const name = observed?.name ?? computerDisplayName(hostRef)
  const online = observed?.online === true
  const profiles = target ? slots?.browserProfiles?.({ mainId, computer: target }) : null
  const tab: ComputerSettingsTab = useSearch({ strict: false }).tab ?? 'overview'
  const navigate = useNavigate()
  // One short section per tab, so the page never needs a long scroll.
  const items = [
    { value: 'overview', label: 'Overview', content: <>
      <SettingsSection title="Status and maintenance" description="Tools, updates and restart.">
        <ComputerCards mainId={mainId} devices={devices} only={registration?.deviceId ?? 'main'} />
      </SettingsSection>
      {target ? <SettingsSection title="Name" description="Shown everywhere this computer appears.">
        <NameRow key={name} name={name} target={target} />
      </SettingsSection> : null}
      {target ? <SettingsSection title="Builds" description="Whether CI builds run here, and how much of the computer they may use.">
        <ComputerBuildSettings target={target} />
      </SettingsSection> : null}
    </> },
    ...target ? [{ value: 'accounts', label: 'Sign-ins', content:
      <SettingsSection title="Sign-ins" description="Codex and Claude accounts on this computer.">
        <ProviderAccountsSettings target={target} />
      </SettingsSection> },
    { value: 'files', label: 'Files and browsers', content: <>
      <SettingsSection title="File sync" description="Workspace files kept in sync on this computer.">
        <ComputerSyncPanel target={target} online={online} />
      </SettingsSection>
      {profiles ? <SettingsSection title="Browser profiles" description="Signed-in browsers Agents can use here.">{profiles}</SettingsSection> : null}
    </> }] : [],
    ...registration ? [{ value: 'connection', label: 'Connection', content: <>
      <SettingsSection title="Connection" description="How the app sends work to this computer.">
        <ConnectionSetupStatus registration={registration} />
        <ComputerPairingRecovery registration={registration} />
      </SettingsSection>
      <SettingsSection title="Remove" description="Stop this computer from connecting.">
        <ComputerRevokeButton key={`${registration.mainId}:${registration.deviceId}`} registration={registration} />
      </SettingsSection>
    </> }] : [],
  ]
  return <section className="settings-editor-page computers-page computer-detail-settings" aria-label={`${name} settings`}>
    <header className="settings-experience-heading computer-detail-heading"><h1>{name}</h1>
      {observed ? <Badge tone={online ? 'success' : 'neutral'} dot>{online ? 'Online' : 'Offline'}</Badge> : null}</header>
    <Tabs label={`${name} settings`} value={tab} items={items} keepMounted
      onValueChange={next => void navigate({ to: '.', search: (prev: Record<string, unknown>) => ({ ...prev, tab: next === 'overview' ? undefined : next as ComputerSettingsTab }), replace: true })} />
  </section>
}

function NameRow({ name, target }: { name: string; target: DeviceProvisioningTarget }) {
  const [draft, setDraft] = useState(name)
  const rename = useRenameComputer()
  const next = draft.trim()
  const saveName = () => rename.mutateAsync({ target, name: next }).then(() => true, () => false)
  useUnsavedChanges({ label: 'computer name', dirty: next !== name, busy: rename.isPending,
    saveDisabled: !next, save: saveName, discard: () => setDraft(name), error: rename.error?.message })
  return <SettingRow title="Computer name">
    <div className="computer-detail-inline">
      <TextField label="Computer name" className="settings-inline-field" value={draft} maxLength={COMPUTER_NAME_MAX_LENGTH} disabled={rename.isPending}
        error={rename.isError ? rename.error.message : undefined} onChange={event => setDraft(event.target.value)} />
      <Button size="sm" variant="primary" disabled={!next || next === name || rename.isPending}
        onClick={() => void saveName()}>{rename.isPending ? 'Saving…' : 'Save name'}</Button>
    </div>
  </SettingRow>
}

type BuildDraft = { revision: number; buildEnabled: boolean; buildPriority: number; buildAllowancePercent: number }

/** Edits start from the read revision; a save against a newer revision is rejected instead of overwriting it. */
export function ComputerBuildSettings({ target }: { target: DeviceProvisioningTarget }) {
  const [read] = useBuildComputers([target])
  const save = useUpdateBuildComputer()
  const [draft, setDraft] = useState<BuildDraft | null>(null)
  const [saved, setSaved] = useState(false)
  if (!read || read.isPending) return <Skeleton width="100%" height="6rem" />
  if (read.isError && !read.data) return <p className="settings-note">Build settings are unavailable.
    <Button size="sm" variant="ghost" onClick={() => void read.refetch()}>Retry</Button></p>
  const preference = read.data!.preference
  const value: BuildDraft = draft ?? { revision: preference.revision, buildEnabled: preference.buildEnabled,
    buildPriority: preference.buildPriority, buildAllowancePercent: preference.buildAllowancePercent }
  const edit = (change: Partial<BuildDraft>) => { setSaved(false); save.reset(); setDraft({ ...value, ...change }) }
  const valid = Number.isInteger(value.buildPriority) && value.buildPriority >= 0 && value.buildPriority <= 100
    && Number.isInteger(value.buildAllowancePercent) && value.buildAllowancePercent >= 10 && value.buildAllowancePercent <= 100
  const stale = draft !== null && draft.revision !== preference.revision
  const discard = () => { setDraft(null); save.reset() }
  const saveBuild = () => save.mutateAsync({ target, expectedRevision: value.revision, commandId: crypto.randomUUID(),
    buildEnabled: value.buildEnabled, buildPriority: value.buildPriority, buildAllowancePercent: value.buildAllowancePercent })
    .then(() => { setDraft(null); setSaved(true); return true }, () => false)
  return <>
    <UnsavedEditorGuard editor={{ label: 'computer build settings', dirty: draft !== null, busy: save.isPending,
      saveDisabled: !valid || stale, save: saveBuild, discard, error: save.error?.message }} />
    <SettingRow title="Run builds here">
      <Switch label="Run builds here" checked={value.buildEnabled} disabled={save.isPending}
        onChange={event => edit({ buildEnabled: event.target.checked })} />
    </SettingRow>
    <SettingRow title="Priority" description="0 to 100. Higher runs builds first.">
      <TextField label="Priority" className="settings-inline-field" type="number" min={0} max={100} disabled={save.isPending}
        value={Number.isFinite(value.buildPriority) ? value.buildPriority : ''}
        onChange={event => edit({ buildPriority: event.target.valueAsNumber })} />
    </SettingRow>
    <SettingRow title="Allowance" description="Share of CPU and memory builds may use, 10 to 100%.">
      <TextField label="Allowance (%)" className="settings-inline-field" type="number" min={10} max={100} disabled={save.isPending}
        value={Number.isFinite(value.buildAllowancePercent) ? value.buildAllowancePercent : ''}
        onChange={event => edit({ buildAllowancePercent: event.target.valueAsNumber })} />
    </SettingRow>
    {stale ? <Alert tone="warning" title="These build settings changed elsewhere."
      action={<Button size="sm" onClick={() => { setDraft(null); save.reset() }}>Load latest</Button>} /> : null}
    {save.isError ? <Alert live tone="danger" title="Couldn’t save build settings">{save.error.message}</Alert> : null}
    <div className="computer-detail-actions">
      {saved && !draft ? <span role="status" className="settings-saved-note">Saved.</span> : null}
      {draft ? <Button size="sm" variant="ghost" disabled={save.isPending} onClick={discard}>Discard</Button> : null}
      <Button size="sm" variant="primary" disabled={!draft || !valid || save.isPending}
        onClick={() => void saveBuild()}>{save.isPending ? 'Saving…' : 'Save build settings'}</Button>
    </div>
  </>
}

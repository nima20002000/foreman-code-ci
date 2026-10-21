import { useNavigate } from '@tanstack/react-router'
import type { NodeBrowserSettings } from '@foreman-code/contracts'
import { computerDisplayName } from '@foreman-code/contracts/computer-activity'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useSelectedMainQuery, useRegisteredComputersQuery } from '../shared/api/computerSettings'
import { useComputerMaintenance, useStartMaintenance } from '../shared/api/computerMaintenance'
import { sessionGeneration } from '../shared/api/sessionBoundary'
import { BrowserProfilesSettings } from '../features/browser-profiles/BrowserProfilesSettings'
import { BrowserSetupDialog } from '../features/browser-profiles/BrowserSetupDialog'
import { BrowserSettingsFields } from '../features/agent-browser/BrowserSettingsFields'
import { useBrowserProfiles } from '../features/browser-profiles/queries'
import { Button } from '../shared/ui/nocturne'
import { browserFilesClient } from './browserClients'
import { browserProfileClient, browserSessionClient, useBrowserRecovery, retainSetupCleanup } from './browserRecovery'

export const browserAuthBoundary = () => String(sessionGeneration())
export function useBrowserComputers() {
  const main = useSelectedMainQuery(), registrations = useRegisteredComputersQuery(main.data?.mainId)
  const mainId = main.data?.mainId
  const targets: DeviceProvisioningTarget[] = mainId ? [
    { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, keyRevision: null, authorizationRevision: null },
    ...(registrations.data?.devices.filter(device => device.status === 'paired').map(device => ({
      hostRef: { kind: 'device' as const, mainId, deviceId: device.deviceId }, applicationInstallationId: device.workerInstallationId,
      keyRevision: device.keyRevision, authorizationRevision: device.authorizationRevision })) ?? []),
  ] : []
  const maintenance = useComputerMaintenance(targets)
  const computers = targets.map((target, index) => ({
    id: target.hostRef.kind === 'main' ? target.hostRef.mainId : target.hostRef.deviceId,
    name: computerDisplayName(target.hostRef), online: target.hostRef.kind === 'main' || maintenance[index]?.data?.status != null,
    runtimeReady: maintenance[index]?.data?.status?.browserRuntime?.ready === true, lastSeenAt: null,
  }))
  return { mainId, targets, computers, error: main.error ?? registrations.error ?? maintenance.find(query => query.error)?.error }
}
export function BrowserProfileManager({ computer }: { computer?: DeviceProvisioningTarget | undefined }) {
  const facts = useBrowserComputers()
  const selected = computer ? computer.hostRef.kind === 'main' ? computer.hostRef.mainId : computer.hostRef.deviceId : undefined
  const repair = useStartMaintenance()
  const targets = facts.targets.filter(target => !selected || (target.hostRef.kind === 'main' ? target.hostRef.mainId : target.hostRef.deviceId) === selected)
  const computers = facts.computers.filter(item => !selected || item.id === selected)
  return <>
    {facts.error ? <p role="alert">Computer readiness could not be read: {facts.error.message}</p> : null}
    <BrowserProfilesSettings visible authBoundary={browserAuthBoundary()} computers={computers}
      currentComputerId={selected ?? facts.mainId ?? ''} port={browserProfileClient} sessionPort={browserSessionClient}
      files={browserFilesClient} onOpenSetup={useBrowserRecovery.getState().openSetup} onSetupCleanupPending={retainSetupCleanup} />
    {targets.map((target, index) => <Button key={JSON.stringify(target)} disabled={repair.isPending || repair.unresolved}
      onClick={() => repair.mutate({ targets: [target], task: { kind: 'repair-browser' } })}>
      Repair browser on {computers[index]?.name}</Button>)}
    {repair.error ? <p role="alert">{repair.error.message}<Button onClick={repair.retryOriginal}>Check original repair</Button></p> : null}
  </>
}
export function ComputerBrowserProfiles({ target }: { target: DeviceProvisioningTarget }) {
  const navigate = useNavigate()
  const catalog = useBrowserProfiles(browserProfileClient, browserAuthBoundary(), true)
  const computerId = target.hostRef.kind === 'main' ? target.hostRef.mainId : target.hostRef.deviceId
  const present = catalog.data?.presentReplicas.filter(replica => replica.computerId === computerId) ?? []
  return <section aria-label="Computer browser profiles"><strong>Browser profiles</strong>
    {catalog.error ? <p role="alert">{catalog.error.message}</p> : <p>{catalog.isPending ? 'Loading profiles…' : present.length
      ? present.map(item => catalog.data?.profiles.find(profile => profile.id === item.profileId)?.name ?? 'Unavailable profile').join(', ') : 'No profiles added here.'}</p>}
    <Button size="sm" onClick={() => { void navigate({ to: '/settings/browser-profiles', search: { mainId: target.hostRef.mainId,
      computer: target.hostRef.kind, ...(target.hostRef.kind === 'device' ? { deviceId: target.hostRef.deviceId } : {}) } }) }}>Manage browser profiles</Button>
  </section>
}
export function NodeBrowserFields({ value, onChange }: {
  value: NodeBrowserSettings | undefined; onChange(value: NodeBrowserSettings | undefined): void
}) {
  const catalog = useBrowserProfiles(browserProfileClient, browserAuthBoundary(), true), navigate = useNavigate()
  return <>{catalog.error ? <p role="alert">{catalog.error.message}</p> : null}
    <BrowserSettingsFields value={value} onChange={onChange} catalog={catalog.data} computer={undefined}
      loading={catalog.isPending} onManageProfiles={() => { void navigate({ to: '/settings/browser-profiles' }) }} /></>
}
export function BrowserSetupHost() {
  const setup = useBrowserRecovery(state => state.setup)
  return setup ? <SelectedSetup /> : null
}
function SelectedSetup() {
  const setup = useBrowserRecovery(state => state.setup)!
  const catalog = useBrowserProfiles(browserProfileClient, browserAuthBoundary(), true), facts = useBrowserComputers()
  return <BrowserSetupDialog authBoundary={browserAuthBoundary()} session={setup}
    profileName={catalog.data?.profiles.find(profile => profile.id === setup.profileId)?.name ?? 'Browser profile'}
    computerName={facts.computers.find(computer => computer.id === setup.computerId)?.name ?? 'Selected computer'}
    port={browserSessionClient} profiles={browserProfileClient} files={browserFilesClient}
    onClosed={() => useBrowserRecovery.getState().openSetup(null)} onCleanupError={message => retainSetupCleanup(setup, message)} />
}

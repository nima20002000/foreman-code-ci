import { computerDisplayName } from '@foreman-code/contracts/computer-activity'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { useSelectedMainQuery, useRegisteredComputersQuery } from '../shared/api/computerSettings'
import { useComputerMaintenance } from '../shared/api/computerMaintenance'
import { sessionGeneration } from '../shared/api/sessionBoundary'
import { computerKey, useComputerActivity } from '../shared/api/computerActivity'

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
  const activity = useComputerActivity()
  const names = new Map(activity.data?.computers.map(computer => [computerKey(computer.target), computer.name]) ?? [])
  // Presence comes from the same activity read as every other computer card, so a page never says Online and Offline at once.
  const presence = new Map(activity.data?.computers.map(computer => [computerKey(computer.target), computer.online]) ?? [])
  const computers = targets.map((target, index) => ({
    id: target.hostRef.kind === 'main' ? target.hostRef.mainId : target.hostRef.deviceId,
    name: names.get(computerKey(target)) ?? computerDisplayName(target.hostRef),
    online: target.hostRef.kind === 'main' || (presence.get(computerKey(target)) ?? maintenance[index]?.data?.status != null),
    runtimeReady: maintenance[index]?.data?.status?.browserRuntime?.ready === true, lastSeenAt: null,
  }))
  return { mainId, targets, computers, error: main.error ?? registrations.error ?? maintenance.find(query => query.error)?.error }
}

import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ResolvedJobDefinitionSpec } from '@foreman-code/contracts/jobs'

export function buildComputerKey(target: Pick<DeviceProvisioningTarget, 'hostRef'>): string {
  const host = target.hostRef
  return `${host.mainId}:${host.kind === 'device' ? host.deviceId : 'main'}`
}
export function buildComputerTarget(target: Pick<ResolvedJobDefinitionSpec['target'],
  'hostRef' | 'registration' | 'mainInstallationId'>): DeviceProvisioningTarget {
  return {
    hostRef: target.hostRef,
    applicationInstallationId: target.registration?.workerInstallationId ?? target.mainInstallationId,
    keyRevision: target.registration?.keyRevision ?? null,
    authorizationRevision: target.registration?.authorizationRevision ?? null,
  }
}

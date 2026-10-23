import type { CiHostStatus, CiInstalledStorage, CiRuntimeWorkerState } from '@foreman-code/contracts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
export { ciEnrollmentDisabled, lockCiEnrollment } from './ciEnrollmentState.js'

export interface CiEnrollmentTarget {
  target: DeviceProvisioningTarget
  executionMode?: 'host' | 'protected'
  buildEnabled: boolean
  connected: boolean
}
export interface CiEnrollmentInventory {
  computers(): Promise<CiEnrollmentTarget[]>
  storage(target: DeviceProvisioningTarget): Promise<CiInstalledStorage | null>
  runtimeStatus?(target: DeviceProvisioningTarget): Promise<CiRuntimeWorkerState | null>
  hostStatus?(target: DeviceProvisioningTarget): Promise<CiHostStatus | null>
  root(principal: ManagementPrincipal, workspaceId: string, template: SourceRootRecord,
    target: DeviceProvisioningTarget): Promise<SourceRootRecord>
}


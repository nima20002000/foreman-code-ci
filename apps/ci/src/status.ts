import { CI_HOST_NAMESPACE, CiHostStatusSchema, type CiHostStatus } from '@foreman-code/contracts'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type { CiContext, DeviceEndpoint } from './environment.js'
import { DomainError } from '@foreman-code/contracts-node/server-kit'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'

const lastStatus = new Map<string, CiHostStatus>()

/** Every status read records the Worker's answer. A background read that yields to foreground Worker work reports
 * that last answer: the Worker is busy, not unavailable. Starts still verify readiness with a foreground status. */
export async function retainCiHostStatus(context: CiContext, hostRef: object,
  read: () => Promise<CiHostStatus>): Promise<CiHostStatus> {
  const key = canonicalJson(hostRef)
  try {
    const status = await read()
    lastStatus.set(key, status)
    return status
  } catch (error) {
    const retained = lastStatus.get(key)
    if (retained && context.platform.isDeviceApplicationAdmissionError(error) && error.reason === 'background_yield') return retained
    throw error
  }
}

export async function readHostCiStatus(context: CiContext, endpoint: DeviceEndpoint,
  target: DeviceProvisioningTarget, buildAllowancePercent?: number): Promise<CiHostStatus | null> {
  if (target.hostRef.kind !== 'device') return null
  const deviceId = target.hostRef.deviceId
  const channel = endpoint.captureRequest(deviceId, CI_HOST_NAMESPACE)
  if (!channel) return null
  const matches = () => channel.binding.workerInstallationId === target.applicationInstallationId
    && channel.binding.keyRevision === target.keyRevision
    && channel.binding.authorizationRevision === target.authorizationRevision
    && canonicalJson(channel.binding) === canonicalJson(endpoint.currentBinding(deviceId))
  if (!matches()) throw new DomainError('CI_ENROLLMENT_OFFLINE', 'The computer connection changed.', 409)
  return retainCiHostStatus(context, { ...target.hostRef, buildAllowancePercent }, async () => {
    const result = await channel.request({ operation: 'status',
      ...(buildAllowancePercent === undefined ? {} : { buildAllowancePercent }) }, { timeoutMs: 30_000 })
    if (!matches()) throw new DomainError('CI_ENROLLMENT_OFFLINE', 'The computer connection changed.', 409)
    return CiHostStatusSchema.parse(result.payload)
  })
}

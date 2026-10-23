// CI functions and constants the rest of the API calls, bound to the platform context so Worker code can call them.
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import type pg from 'pg'
import type { CiRunRecord } from '@foreman-code/contracts'
import { expireOverdueCiRuns as ciExpireOverdueCiRuns } from '@foreman-code/ci/deadlines'
import { readHostCiStatus as ciReadHostCiStatus } from '@foreman-code/ci/status'
import type { DeviceEndpoint } from '@foreman-code/ci/environment'
import { platformCiContext } from './platform.js'

export { CI_BUSY_TICKET } from '@foreman-code/ci/deadlines'
export { hostCiCapacity } from '@foreman-code/ci/capacity'
export { cloudCiId } from '@foreman-code/ci/cloudProviders'
export { buildComputerKey, buildComputerTarget } from '@foreman-code/ci/buildComputers'
export { disabledCiEnrollmentHosts } from '@foreman-code/ci/ciEnrollmentState'
export { buildCiRuntimeContext, ciRuntimeInputDigest, parseCiLock } from '../jobs/ciRuntimeContext.mjs'

export function expireOverdueCiRuns(pool: pg.Pool, now?: Date,
  reconcile?: (run: CiRunRecord, hostKey: string | null) => Promise<CiRunRecord>): Promise<number> {
  return ciExpireOverdueCiRuns(platformCiContext, pool, now, reconcile)
}

export function readHostCiStatus(endpoint: DeviceEndpoint, target: DeviceProvisioningTarget, buildAllowancePercent?: number) {
  return ciReadHostCiStatus(platformCiContext, endpoint, target, buildAllowancePercent)
}

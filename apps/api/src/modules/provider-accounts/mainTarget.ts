import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { readMainInstallationId } from '../devices/index.js'
import { DomainError } from '../errors.js'
import type { SqlQuery } from '../../infrastructure/transaction.js'

/** Main's own provider-account target. */
export function mainProvisioningTarget(mainId: string): DeviceProvisioningTarget {
  return { hostRef: { kind: 'main', mainId }, applicationInstallationId: mainId, keyRevision: null, authorizationRevision: null }
}

/** Main's target before startup has read its installation identity. */
export async function readMainProvisioningTarget(sql: SqlQuery): Promise<DeviceProvisioningTarget> {
  const mainId = await readMainInstallationId(sql)
  if (!mainId) throw new DomainError('PROVIDER_ACCOUNT_TARGET_UNAVAILABLE', 'The canonical Main installation is unavailable.', 503)
  return mainProvisioningTarget(mainId)
}

import type pg from 'pg'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import { withTransaction } from '../../../infrastructure/transaction.js'
import { authorizeDeviceHost } from '../../devices/hostAuthorization.js'

export interface HostHarnessOverrideAuthority {
  authorize(principal: ManagementPrincipal, action: 'harnesses:read' | 'harnesses:update', hostRef: CanonicalMachineReference, applicationInstallationId: string, client?: pg.PoolClient): Promise<void>
}

/** Checks the caller's live grant and the host's installation, inside the caller's transaction or its own. */
export function deviceHostOverrideAuthority(pool: pg.Pool): HostHarnessOverrideAuthority {
  return { async authorize(principal, action, hostRef, applicationInstallationId, client) {
    if (client) { await authorizeDeviceHost(client, principal, action, hostRef, applicationInstallationId); return }
    await withTransaction(pool, async (connection) => {
      await authorizeDeviceHost(connection, principal, action, hostRef, applicationInstallationId)
    })
  } }
}

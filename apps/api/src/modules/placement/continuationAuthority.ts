import type pg from 'pg'
import { readRunAuthorizationPrincipal } from '../access/index.js'
import { readLiveManagementPrincipal } from '../access/index.js'
import type { ProductionDeviceRuntime } from '../devices/index.js'
import { DomainError } from '../errors.js'
import { deliveryTransactionClient } from '../interactions/connection.js'
import { credentialAuthority } from '../interactions/index.js'
import type { SqlQuery } from '../../infrastructure/transaction.js'
import { readStoredRemoteReceipt } from '../runs/remote/persistence.js'
import type { WorkspaceLocationService } from '../workspaces/location.js'
import type { AcceptedDestinationContinuation } from './continuation.js'
import type { AgentPlacementProducer } from './agentProducer.js'
import { assertRemoteExecutionAuthority } from './executionAuthority.js'

/**
 * Live destination checks before a placed execution continues: the connected Worker is the one that ran it, its
 * authority is still current, and the placement producer's pins still hold. Needs the placement producer, which exists
 * only after startup, so `placement` returns undefined until then.
 */
export function createAcceptedDestinationContinuation(dependencies: {
  pool: pg.Pool
  locations: WorkspaceLocationService
  devices: Pick<ProductionDeviceRuntime, 'endpointForDomains'>
  placement: () => AgentPlacementProducer | undefined
}): AcceptedDestinationContinuation {
  const { pool, locations, devices, placement: currentPlacement } = dependencies
  return {
    async assertCurrent(binding, signal, purpose) {
      signal?.throwIfAborted()
      const sql = deliveryTransactionClient() ?? pool
      const placement = currentPlacement()
      if (!placement) {
        throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The current accepted placement authority is unavailable.', 503)
      }
      if (binding.placement.hostRef.kind === 'device') {
        const receipt = await readStoredRemoteReceipt(sql, binding.intent.operationId)
        if (receipt?.native) {
          // Restart preserves Main's admitted lifetime; it does not authorize a new Worker operation.
          const authenticated = purpose === 'restart' ? receipt.connection
            : devices.endpointForDomains().currentBinding(binding.placement.hostRef.deviceId)
          if (!authenticated) {
            throw new DomainError('REMOTE_DISPATCH_UNAVAILABLE', 'The authenticated execution connection is unavailable.', 503)
          }
          if (authenticated.bootId !== receipt.connection.bootId) {
            throw new DomainError('REMOTE_NATIVE_OWNER_CLOSED', 'The connected computer restarted during the run.', 409)
          }
          await assertRemoteExecutionAuthority(sql, locations, {
            version: 1, intent: binding.intent, placement: binding.placement, action: 'read',
          }, authenticated, placement)
          signal?.throwIfAborted()
          return
        }
      }
      const run = await readRunAuthorizationPrincipal(sql, binding.intent.runId)
      if (!run) throw new DomainError('AGENT_PLACEMENT_UNAVAILABLE', 'The current accepted placement authority is unavailable.', 503)
      const current = await credentialAuthority(sql as SqlQuery, binding.intent.executionId, 'workflow')
      await placement.assertPinsCurrent(sql, binding.placement,
        await readLiveManagementPrincipal(sql, run.principalId), run.workspaceId,
        current.nativeSessionId ? { purpose: 'resident' } : undefined)
      signal?.throwIfAborted()
    },
  }
}

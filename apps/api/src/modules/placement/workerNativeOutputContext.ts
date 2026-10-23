import { isDeepStrictEqual } from 'node:util'
import { DeviceConnectionIdentitySchema } from '@foreman-code/contracts/device-identity'
import { transferContextForBinding } from '../byte-transfer/carrier.js'
import type { ProductionDeviceRuntime } from '../devices/productionRuntime.js'
import { DomainError } from '../errors.js'
import { readRunWorkflowScopeForShare, type PostgresArtifactPublicationAuthority } from '../runs/remote/nativeArtifactAuthority.js'
import type { createWorkerNativeOutputAuthorizationPort } from './workerMcpRelay.js'

/**
 * The accepted artifact publication a Worker's native-output request refers to. The Worker connection must still be the
 * one that sent the request, and the Run must exist.
 */
export function workerNativeOutputContext(dependencies: {
  artifactAuthority: Pick<PostgresArtifactPublicationAuthority, 'resolveWorkflowContext'>
  devices: Pick<ProductionDeviceRuntime, 'currentBinding'>
}): Parameters<typeof createWorkerNativeOutputAuthorizationPort>[1] {
  const { artifactAuthority, devices } = dependencies
  return async (input, connection, sql) => {
    const binding = devices.currentBinding(connection.deviceId)
    const identity = binding && DeviceConnectionIdentitySchema.parse({ mainId: binding.mainId,
      deviceId: binding.deviceId, workerInstallationId: binding.workerInstallationId, keyRevision: binding.keyRevision,
      authorizationRevision: binding.authorizationRevision, bootId: binding.bootId,
      connectionGeneration: binding.connectionGeneration })
    const original = DeviceConnectionIdentitySchema.parse({ mainId: connection.mainId, deviceId: connection.deviceId,
      workerInstallationId: connection.workerInstallationId, keyRevision: connection.keyRevision,
      authorizationRevision: connection.authorizationRevision, bootId: connection.bootId,
      connectionGeneration: connection.connectionGeneration })
    if (!binding || !isDeepStrictEqual(identity, original)) {
      throw new DomainError('NATIVE_ARTIFACT_AUTHORITY_DENIED', 'The original artifact connection changed.', 403)
    }
    const scope = await readRunWorkflowScopeForShare(sql, input.intent.runId)
    if (!scope) throw new DomainError('NATIVE_ARTIFACT_CONTEXT_UNAVAILABLE', 'The original artifact Run is unavailable.', 409)
    return artifactAuthority.resolveWorkflowContext({ workspaceId: scope.workspaceId, workflowId: scope.workflowId,
      runId: input.intent.runId, nodeId: input.intent.nodeId, executionId: input.intent.executionId,
      attemptId: input.intent.attemptId, placementHash: input.intent.bindingHash }, transferContextForBinding(binding), sql)
  }
}

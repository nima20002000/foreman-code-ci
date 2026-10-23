// Main's view of the build computers workspace CI enrollment can use: their registrations, connections, runtime and
// host CI status, and the writable workspace root each one binds.
import type pg from 'pg'
import { CI_HOST_NAMESPACE, CI_RUNTIME_NAMESPACE, CiRuntimeWorkerStateSchema, type CiHostStatus, type CiInstalledStorage,
  type CiRuntimeWorkerState } from '@foreman-code/contracts'
import { DeviceProvisioningTargetSchema, type DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'
import { WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { CiEnrollmentInventory, CiEnrollmentTarget } from '@foreman-code/ci/ciEnrollmentInventory'
import type { CiRuntimeWorker } from '@foreman-code/ci/ciRuntimeWorker'
import type { DeviceEndpoint } from '../devices/deviceEndpoint.js'
import { DeviceAccessError } from '../devices/access.js'
import type { PostgresSourceService } from '../sources/service.js'
import { assertBuildComputerTarget } from '../settings/index.js'
import type { WorkerExecutionPolicy } from '../settings/index.js'
import type { ManagedWorkspaceRootService } from '../workspace-roots/index.js'
import { DomainError } from '../errors.js'
import { readHostCiStatus } from './values.js'
import { canonicalJson } from '@foreman-code/contracts/canonical-json'
import { jobDigest } from '../jobs/digest.js'

export class ProductionCiEnrollmentInventory implements CiEnrollmentInventory {
  constructor(private readonly pool: pg.Pool, private readonly sources: PostgresSourceService,
    private readonly endpoint: () => DeviceEndpoint, private readonly main: () => CiRuntimeWorker | undefined,
    private readonly workerExecution: WorkerExecutionPolicy,
    private readonly managedRoots: ManagedWorkspaceRootService) {}

  async computers(): Promise<CiEnrollmentTarget[]> {
    const rows = await this.pool.query<{ target: unknown; build_enabled: boolean }>(
      'select target,build_enabled from build_computer_preferences order by host_key')
    const computers: CiEnrollmentTarget[] = []
    for (const row of rows.rows) {
      const target = DeviceProvisioningTargetSchema.parse(row.target)
      try {
        await assertBuildComputerTarget(this.pool, target)
      } catch (error) {
        if (error instanceof DeviceAccessError
          || error instanceof DomainError && error.code === 'BUILD_COMPUTER_IDENTITY_CHANGED') continue
        throw error
      }
      const binding = target.hostRef.kind === 'device' ? this.endpoint().currentBinding(target.hostRef.deviceId) : null
      const connected = target.hostRef.kind === 'main' || !!binding
        && binding.workerInstallationId === target.applicationInstallationId
        && binding.keyRevision === target.keyRevision && binding.authorizationRevision === target.authorizationRevision
      const hostCi = target.hostRef.kind === 'device' && this.endpoint().capabilities(target.hostRef.deviceId)
        .some(value => value.namespace === CI_HOST_NAMESPACE && value.mainCanRequest)
      computers.push({ target, buildEnabled: row.build_enabled, connected, executionMode: hostCi ? 'host' : 'protected' })
    }
    return computers
  }

  async storage(target: DeviceProvisioningTarget): Promise<CiInstalledStorage | null> {
    return (await this.runtimeStatus(target))?.installedStorage ?? null
  }

  async hostStatus(target: DeviceProvisioningTarget): Promise<CiHostStatus | null> {
    await assertBuildComputerTarget(this.pool, target)
    this.workerExecution.requireEnabled(target.hostRef)
    return readHostCiStatus(this.endpoint(), target)
  }

  async runtimeStatus(target: DeviceProvisioningTarget): Promise<CiRuntimeWorkerState | null> {
    await assertBuildComputerTarget(this.pool, target)
    this.workerExecution.requireEnabled(target.hostRef)
    if (target.hostRef.kind === 'main') {
      return await this.main()?.handle({ operation: 'status' }) ?? null
    }
    const channel = this.endpoint().captureRequest(target.hostRef.deviceId, CI_RUNTIME_NAMESPACE)
    if (!channel) return null
    const current = () => this.endpoint().currentBinding(target.hostRef.kind === 'device' ? target.hostRef.deviceId : '')
    const matches = () => channel.binding.workerInstallationId === target.applicationInstallationId
      && channel.binding.keyRevision === target.keyRevision && channel.binding.authorizationRevision === target.authorizationRevision
      && canonicalJson(channel.binding) === canonicalJson(current())
    if (!matches()) throw new DomainError('CI_ENROLLMENT_OFFLINE', 'The computer connection changed.', 409)
    const result = await channel.request({ operation: 'status' }, { timeoutMs: 30_000 })
    if (!matches()) throw new DomainError('CI_ENROLLMENT_OFFLINE', 'The computer connection changed.', 409)
    return CiRuntimeWorkerStateSchema.parse(result.payload)
  }

  async root(principal: ManagementPrincipal, workspaceId: string, template: SourceRootRecord,
    target: DeviceProvisioningTarget, source: 'http' | 'mcp' = 'mcp'): Promise<SourceRootRecord> {
    await assertBuildComputerTarget(this.pool, target)
    this.workerExecution.requireEnabled(target.hostRef)
    const roots = (await this.sources.rootList(principal, source, { workspaceId, limit: 100 })).items
    const matching = roots.find(root => canonicalJson(root.selection.hostRef) === canonicalJson(target.hostRef)
      && canonicalJson(root.source) === canonicalJson(template.source)
      && root.binding.accessMode === 'exclusive-write'
      && (target.hostRef.kind === 'main' || root.binding.workerInstallationId === target.applicationInstallationId
        && root.registration?.keyRevision === target.keyRevision
        && root.registration?.authorizationRevision === target.authorizationRevision))
    if (matching) return matching
    const rows = await this.pool.query<{ record: unknown }>(`select p.record from workspace_root_policy_heads h
      join workspace_root_policies p on p.root_policy_id=h.root_policy_id and p.root_policy_revision=h.root_policy_revision
      where h.workspace_id=$1 and p.revoked_at is null`, [workspaceId])
    const policy = rows.rows.map(row => WorkspaceRootPolicySchema.parse(row.record))
      .find(value => canonicalJson(value.hostRef) === canonicalJson(target.hostRef) && value.accessMode === 'read-write'
        && value.applicationInstallationId === target.applicationInstallationId
        && (target.hostRef.kind === 'main' || value.registration?.keyRevision === target.keyRevision
          && value.registration?.authorizationRevision === target.authorizationRevision))
      ?? await this.managedRoots.ensure(principal, source, workspaceId, target)
    const selection = { hostRef: policy.hostRef, rootPolicyId: policy.rootPolicyId,
      rootPolicyRevision: policy.rootPolicyRevision, locationRevision: policy.locationRevision }
    const current = roots.find(root => canonicalJson(root.selection.hostRef) === canonicalJson(target.hostRef)
      && root.selection.rootPolicyId === policy.rootPolicyId)
    const previousRevision = current?.binding.bindingRevision ?? 0
    const commandId = `enroll-root-${jobDigest({ workspaceId, selection, source: template.source,
      previous: previousRevision })}`
    return (await this.sources.bindRoot(principal, source, { workspaceId, commandId, selection,
      source: template.source, accessMode: 'exclusive-write',
      expectedBindingRevision: previousRevision })).value
  }
}

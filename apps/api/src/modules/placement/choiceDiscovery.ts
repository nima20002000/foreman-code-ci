import type pg from 'pg'
import { withTransaction } from '../../infrastructure/transaction.js'
import { AgentConfigurationVersionSchema, withAdvancedDefaults, type AgentConfigurationVersion } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import type { NodePlacementChoice, NodePlacementChoicesInput, NodePlacementChoicesResult } from '@foreman-code/contracts/placement-readback'
import { SavedNodePlacementSchema } from '@foreman-code/contracts/node-placement'
import { SourceRootRecordSchema, type SourceRootRecord } from '@foreman-code/contracts/source-admission'
import type { WorkspaceRootPolicy } from '@foreman-code/contracts/workspace-root-policies'
import { sameWorkflowValue } from '@foreman-code/contracts/current'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import type { SourceAdmissionPort } from '../sources/index.js'
import type { WorkspaceRootPolicyPort } from '../sources/index.js'
import { provisionPairedAgentRoots, type PairedRootServices } from './pairedRoots.js'
import type { PlacementChoiceDiscovery } from './choicesService.js'
import { computerNameKey, readComputerNames } from '../computers/index.js'
import { computerAvailabilityFailure, type ComputerAvailability } from './computerAvailability.js'

type DiscoveryServices = PairedRootServices & {
  roots: WorkspaceRootPolicyPort
  sources: SourceAdmissionPort
  ensureComputerReady?: (host: CanonicalMachineReference) => Promise<void>
  /** Whether a paired computer is connected now. */
  computerOnline?: (host: CanonicalMachineReference) => boolean
}
type UnavailableComputer = NonNullable<NodePlacementChoicesResult['unavailableComputers']>[number]

type PlacementRootPolicy = Pick<WorkspaceRootPolicy, 'hostRef' | 'applicationInstallationId'
  | 'rootPolicyId' | 'rootPolicyRevision' | 'locationRevision' | 'canonicalProjectRoot'>

function matchesConfiguration(profile: HostHarnessOverride, configuration: AgentConfigurationVersion): boolean {
  const requested = configuration.harnessProfileSelection
  if (requested && (profile.instanceId !== requested.instanceId
    || profile.instanceRevision !== requested.instanceRevision
    || !sameWorkflowValue(profile.target.hostRef, requested.target.hostRef)
    || profile.target.applicationInstallationId !== requested.target.applicationInstallationId)) {
    return false
  }
  return profile.enabled && sameWorkflowValue(
    withAdvancedDefaults(profile.configuration), withAdvancedDefaults(configuration.harness),
  )
}

/** Discovery prepares paired storage through shared services and reuses placement admission authorities. */
export class ProductionPlacementChoiceDiscovery implements PlacementChoiceDiscovery {
  constructor(private readonly pool: pg.Pool, private readonly services: () => DiscoveryServices) {}

  async list(principal: ManagementPrincipal, input: NodePlacementChoicesInput,
    source: 'http' | 'mcp' = 'mcp'): Promise<{ choices: NodePlacementChoice[]; pending: boolean
      unavailableComputers: UnavailableComputer[] }> {
    const services = this.services()
    const configuration = await withTransaction(this.pool, async sql => {
      const row = (await sql.query<{ record: unknown }>(
        'select record from agent_configuration_versions where id=$1 and workspace_id=$2',
        [input.agentConfigurationVersionId, input.workspaceId],
      )).rows[0]
      return AgentConfigurationVersionSchema.parse(row?.record)
    })
    let pending = await provisionPairedAgentRoots(this.pool, services, principal, input.workspaceId, configuration,
      matchesConfiguration, source)
    const profiles = await withTransaction(this.pool, async sql => {
      const roots = await this.sourceRoots(sql, input.workspaceId)
      const profiles: HostHarnessOverride[] = []
      for (const root of roots) {
        const installationId = root.binding.workerInstallationId ?? root.binding.mainId
        profiles.push(...(await services.profiles.list(root.selection.hostRef, installationId, sql))
          .filter(profile => matchesConfiguration(profile, configuration)))
      }
      return profiles
    })
    const readiness = await this.probeReadiness(services, profiles)
    // Root, source and profile metadata may change while a computer is being checked.
    return withTransaction(this.pool, async sql => {
      const roots = await this.sourceRoots(sql, input.workspaceId)
      const choices: NodePlacementChoice[] = []
      for (const root of roots) {
        let policy: PlacementRootPolicy = { ...root.selection,
          applicationInstallationId: root.binding.workerInstallationId ?? root.binding.mainId,
          canonicalProjectRoot: root.binding.canonicalPath }
        let rootUnavailableReason: string | null = null
        try {
          // Location changes do not replace an existing host's approved source namespace.
          policy = await services.roots.resolve(sql, principal, {
            workspaceId: input.workspaceId, ...root.selection,
          })
          await services.sources.resolveRootBinding(sql, principal, {
            workspaceId: input.workspaceId, rootId: root.binding.rootId,
            bindingRevision: root.binding.bindingRevision, source: root.source,
          })
        } catch (error) {
          if (!(error instanceof DomainError) || ![403, 404, 409, 410].includes(error.status)) throw error
          rootUnavailableReason = error.code === 'SOURCE_UNAVAILABLE'
            ? 'The approved source was released. Approve and bind the source again.'
            : error.message
        }
        const profiles = await services.profiles.list(policy.hostRef, policy.applicationInstallationId, sql)
        for (const profile of profiles.filter(value => matchesConfiguration(value, configuration))) {
          const found = await this.choice(sql, services, policy, root, profile, rootUnavailableReason, readiness)
          choices.push(found.choice)
          pending ||= found.pending
        }
      }
      return { choices, pending,
        unavailableComputers: await this.unavailableComputers(sql, services, configuration, roots, choices) }
    })
  }

  /** Every paired computer stays offered: one with no choice above says in plain words why it can't run this Agent.
   * Main is always offered as the workflow default, so only connected computers are listed here. */
  private async unavailableComputers(sql: pg.PoolClient, services: DiscoveryServices,
    configuration: AgentConfigurationVersion, roots: readonly SourceRootRecord[],
    choices: readonly NodePlacementChoice[]): Promise<UnavailableComputer[]> {
    const main = (await sql.query<{ id: string }>(
      'select id::text as id from application_installation where singleton=true')).rows[0]
    if (!main) return []
    const devices = await sql.query<{ id: string }>(`select id::text as id from device_registrations
      where main_id=$1 and record->>'status'='paired' order by id limit 100`, [main.id])
    const names = await readComputerNames(sql, main.id)
    const driver = configuration.harness.harness
    const harness = driver === 'claude' ? 'Claude' : 'Codex'
    const computers: UnavailableComputer[] = []
    for (const { id: deviceId } of devices.rows) {
      const hostRef = { kind: 'device' as const, mainId: main.id, deviceId }
      if (choices.some(choice => sameWorkflowValue(choice.placement.hostRef, hostRef))) continue
      const name = names.get(computerNameKey(main.id, deviceId)) ?? `Computer ${deviceId.slice(0, 8)}`
      const installed = services.registry.installations.list().some(installation => installation.installed
        && installation.driverId === driver && sameWorkflowValue(installation.hostRef, hostRef))
      let reason = `${name} has no ${harness} setup that matches this agent’s model and settings yet.`
      if (services.computerOnline && !services.computerOnline(hostRef)) reason = `${name} is offline.`
      else if (driver !== 'codex') reason = `${harness} agents run only on Main for now, not on ${name}.`
      else if (!installed) reason = `${harness} isn’t installed on ${name}.`
      else if (!roots.some(root => sameWorkflowValue(root.selection.hostRef, hostRef))) {
        reason = `This workspace’s project isn’t set up on ${name} yet.`
      }
      computers.push({ hostRef, name, reason })
    }
    return computers
  }

  private async sourceRoots(sql: pg.PoolClient, workspaceId: string) {
    const rows = await sql.query<{ record: unknown }>(`select b.record from source_root_catalog c
      join source_root_bindings b on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision
      where c.workspace_id=$1 order by c.root_id`, [workspaceId])
    return rows.rows.map(row => SourceRootRecordSchema.parse(row.record))
  }

  private installedProfile(services: DiscoveryServices, profile: HostHarnessOverride): boolean {
    return services.registry.installations.list().some(installation => installation.installed
      && sameWorkflowValue(installation.hostRef, profile.target.hostRef)
      && installation.harnessInstallationId === profile.target.harnessInstallationId
      && installation.installationFingerprint === profile.target.installationFingerprint)
  }

  private supportedProfile(profile: HostHarnessOverride): boolean {
    return profile.driverId === 'codex' || profile.driverId === 'claude' && profile.target.hostRef.kind === 'main'
  }

  private async probeReadiness(services: DiscoveryServices, profiles: HostHarnessOverride[]) {
    const computers = new Map<string, ComputerAvailability>()
    const results = new Map<string, ComputerAvailability>()
    for (const profile of profiles) {
      const key = commandInputHash(profile)
      if (results.has(key) || !this.supportedProfile(profile) || !this.installedProfile(services, profile)) continue
      const host = profile.target.hostRef
      const computerKey = commandInputHash({ host, installationId: profile.target.applicationInstallationId })
      let computer = computers.get(computerKey)
      if (!computer) {
        computer = await this.checkReadiness(() => services.ensureComputerReady?.(host))
        computers.set(computerKey, computer)
      }
      const readiness = computer.reason === null
        ? await this.checkReadiness(() => services.ensureProfileReady?.(profile)) : computer
      results.set(key, readiness)
    }
    return results
  }

  private async checkReadiness(check: () => Promise<void> | undefined): Promise<ComputerAvailability> {
    try {
      await check()
      return { reason: null, pending: false }
    } catch (error) {
      const availability = computerAvailabilityFailure(error)
      if (availability) return availability
      if (!(error instanceof DomainError) || ![409, 422, 503].includes(error.status)) throw error
      return { reason: error.message, pending: error.code === 'HARNESS_PROFILE_CHECK_PENDING' }
    }
  }

  private async choice(sql: pg.PoolClient, services: DiscoveryServices, policy: PlacementRootPolicy,
    root: SourceRootRecord, profile: HostHarnessOverride, rootUnavailableReason: string | null,
    readiness: ReadonlyMap<string, ComputerAvailability>,
  ): Promise<{ choice: NodePlacementChoice; pending: boolean }> {
    const placement = SavedNodePlacementSchema.parse({ schemaVersion: 1, hostRef: policy.hostRef,
      rootPolicyId: policy.rootPolicyId, rootPolicyRevision: policy.rootPolicyRevision,
      locationRevision: policy.locationRevision, projectRoot: policy.canonicalProjectRoot,
      cwdPolicy: 'project-root', relativeCwd: '', instanceId: profile.instanceId,
      instanceRevision: profile.instanceRevision, harnessInstallationId: profile.target.harnessInstallationId,
      source: root.source, rootBinding: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision } })
    let reason = rootUnavailableReason
    let pending = false
    if (reason === null) {
      if (!this.supportedProfile(profile)) {
        reason = 'This harness does not support workflow execution on this computer.'
      } else if (!this.installedProfile(services, profile)) {
        reason = 'The matching harness profile needs qualification on this computer.'
      } else {
        const observed = readiness.get(commandInputHash(profile))
        reason = observed?.reason ?? null
        pending = observed?.pending ?? false
        if (!observed) {
          reason = 'Computer settings changed while checking readiness. Refresh the choices.'
          pending = true
        } else if (reason === null && !await services.registry.profileEvidence(profile, sql)) {
          reason = 'The matching harness profile needs qualification on this computer.'
        }
      }
    }
    const named = (await readComputerNames(sql, policy.hostRef.mainId)).get(computerNameKey(
      policy.hostRef.mainId, policy.hostRef.kind === 'device' ? policy.hostRef.deviceId : undefined))
    const hostLabel = named ?? (policy.hostRef.kind === 'main' ? 'Main' : `Computer ${policy.hostRef.deviceId}`)
    return { pending, choice: { id: commandInputHash(placement),
      label: `${hostLabel} · ${profile.driverId} · ${policy.canonicalProjectRoot}`,
      placement, availability: reason === null ? 'ready' : 'unavailable', reason } }
  }
}

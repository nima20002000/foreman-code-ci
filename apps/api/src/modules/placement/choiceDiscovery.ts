import type pg from 'pg'
import { basename } from 'node:path'
import { withTransaction } from '../../infrastructure/transaction.js'
import { AgentConfigurationVersionSchema, withAdvancedDefaults, type AgentConfigurationVersion } from '@foreman-code/contracts'
import type { ManagementPrincipal } from '@foreman-code/contracts/management'
import type { HostHarnessOverride } from '@foreman-code/contracts/harness-registry'
import type { CanonicalMachineReference } from '@foreman-code/contracts/device-identity'
import type { NodePlacementChoice, NodePlacementChoicesInput, NodePlacementChoicesResult } from '@foreman-code/contracts/placement-readback'
import { SavedNodePlacementSchema } from '@foreman-code/contracts/node-placement'
import { SourceRootRecordSchema, type SourceRootRecord } from '@foreman-code/contracts/source-admission'
import { WorkspaceRootPolicySchema, type WorkspaceRootPolicy } from '@foreman-code/contracts/workspace-root-policies'
import { sameWorkflowValue } from '@foreman-code/contracts/current'
import { commandInputHash } from '../commands/postgres.js'
import { DomainError } from '../errors.js'
import { isAuthorized } from '../access/index.js'
import type { HostHarnessOverrideService } from '../harnesses/index.js'
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
  harnessInstances?: Pick<HostHarnessOverrideService, 'prepareWorkerConfiguration'>
}
type UnavailableComputer = NonNullable<NodePlacementChoicesResult['unavailableComputers']>[number]

type PlacementRootPolicy = Pick<WorkspaceRootPolicy, 'hostRef' | 'applicationInstallationId'
  | 'rootPolicyId' | 'rootPolicyRevision' | 'locationRevision' | 'canonicalProjectRoot' | 'bindingPurpose'>

function folderChoices(choices: NodePlacementChoice[]): NodePlacementChoice[] {
  const folders = new Map<string, NodePlacementChoice>()
  for (const choice of choices) {
    const key = commandInputHash({ host: choice.placement.hostRef, folder: choice.placement.projectRoot })
    const previous = folders.get(key)
    if (!previous || previous.availability !== 'ready' && choice.availability === 'ready') folders.set(key, choice)
  }
  return [...folders.values()]
}

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
    if (await services.sources.isPlainWorkspace?.(principal, input.workspaceId)) {
      return this.listFolders(services, principal, input, configuration, source)
    }
    const sourceFailures = await this.refreshSources(services, principal, input.workspaceId, source)
    let pending = await provisionPairedAgentRoots(this.pool, services, principal, input.workspaceId, configuration,
      matchesConfiguration, source)
    const preparation = await this.prepareWorkerProfiles(services, principal, input.workspaceId, configuration, source)
    pending ||= [...preparation.values()].some(value => value.pending)
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
    const readiness = await this.probeReadiness(services, profiles, preparation)
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
          rootUnavailableReason = sourceFailures.get(root.binding.rootId) ?? error.message
        }
        const profiles = await services.profiles.list(policy.hostRef, policy.applicationInstallationId, sql)
        for (const profile of profiles.filter(value => matchesConfiguration(value, configuration))) {
          const found = await this.choice(sql, services, policy, root, profile, rootUnavailableReason, readiness)
          choices.push(found.choice)
          pending ||= found.pending
        }
      }
      return { choices: folderChoices(choices), pending,
        unavailableComputers: await this.unavailableComputers(sql, services, configuration, roots, choices, preparation) }
    })
  }

  private async refreshSources(services: DiscoveryServices, principal: ManagementPrincipal,
    workspaceId: string, source: 'http' | 'mcp') {
    const failures = new Map<string, string>()
    const roots = await withTransaction(this.pool, sql => this.sourceRoots(sql, workspaceId))
    for (const root of roots) {
      try {
        await withTransaction(this.pool, async sql => {
          await services.roots.resolve(sql, principal, { workspaceId, ...root.selection })
          await services.sources.resolveRootBinding(sql, principal, { workspaceId, rootId: root.binding.rootId,
            bindingRevision: root.binding.bindingRevision, source: root.source })
        })
      } catch (error) {
        if (!(error instanceof DomainError)) throw error
        if (!['SOURCE_UNAVAILABLE', 'SOURCE_NOT_FOUND', 'SOURCE_ROOT_NOT_FOUND', 'SOURCE_ROOT_CONFLICT'].includes(error.code)) {
          if ([403, 404, 409, 410].includes(error.status)) continue
          throw error
        }
        try {
          // Capture and host attestation must run after the read transaction has released its locks.
          await services.sources.setupRoot(principal, source, { workspaceId,
            commandId: `setup-choice-${root.binding.rootId}-${root.binding.bindingRevision}`,
            selection: root.selection, accessMode: root.binding.accessMode })
        } catch (setupError) {
          failures.set(root.binding.rootId, setupError instanceof Error ? setupError.message : String(setupError))
        }
      }
    }
    return failures
  }

  private async listFolders(services: DiscoveryServices, principal: ManagementPrincipal,
    input: NodePlacementChoicesInput, configuration: AgentConfigurationVersion, source: 'http' | 'mcp') {
    const savedPolicies = await withTransaction(this.pool, sql => services.roots.read(sql, principal, input.workspaceId))
    const policies = savedPolicies.filter(policy => policy.bindingPurpose !== 'ci-enrollment'
      || !savedPolicies.some(other => other.bindingPurpose !== 'ci-enrollment'
        && sameWorkflowValue(other.hostRef, policy.hostRef)))
    const preparation = await this.prepareWorkerProfiles(services, principal, input.workspaceId, configuration, source, policies)
    const profiles: HostHarnessOverride[] = []
    for (const policy of policies) profiles.push(...(await services.profiles.list(policy.hostRef, policy.applicationInstallationId))
      .filter(profile => matchesConfiguration(profile, configuration)))
    const readiness = await this.probeReadiness(services, profiles, preparation)
    return withTransaction(this.pool, async sql => {
      const choices: NodePlacementChoice[] = []
      let pending = [...preparation.values()].some(value => value.pending)
      for (const selected of policies) {
        let policy: PlacementRootPolicy = selected
        let rootUnavailableReason: string | null = null
        try {
          policy = await services.roots.resolve(sql, principal, selected)
        } catch (error) {
          if (!(error instanceof DomainError) || ![403, 404, 409, 410].includes(error.status)) throw error
          rootUnavailableReason = error.message
        }
        for (const profile of (await services.profiles.list(policy.hostRef, policy.applicationInstallationId, sql))
          .filter(profile => matchesConfiguration(profile, configuration))) {
          const found = await this.choice(sql, services, policy, undefined, profile, rootUnavailableReason, readiness)
          choices.push(found.choice)
          pending ||= found.pending
        }
      }
      return { choices: folderChoices(choices), pending, unavailableComputers: await this.unavailableComputers(sql, services, configuration,
        policies.map(policy => ({ selection: { hostRef: policy.hostRef } })), choices, preparation) }
    })
  }

  private async prepareWorkerProfiles(services: DiscoveryServices, principal: ManagementPrincipal, workspaceId: string,
    configuration: AgentConfigurationVersion, source: 'http' | 'mcp', policies?: WorkspaceRootPolicy[]) {
    const results = new Map<string, ComputerAvailability>()
    const harnessInstances = services.harnessInstances
    if (!harnessInstances || configuration.harness.harness !== 'codex' || configuration.harnessProfileSelection
      || !isAuthorized(principal, 'harnesses:update')) return results
    const roots = policies ? policies.map(policy => ({ selection: { hostRef: policy.hostRef },
      binding: { workerInstallationId: policy.registration?.workerInstallationId ?? null } }))
      : await withTransaction(this.pool, sql => this.sourceRoots(sql, workspaceId))
    for (const root of roots) {
      const host = root.selection.hostRef
      const key = commandInputHash(host)
      if (host.kind !== 'device' || results.has(key) || services.computerOnline && !services.computerOnline(host)) continue
      const installation = services.registry.installations.list().find(value => value.installed
        && value.driverId === 'codex' && value.installationFingerprint && sameWorkflowValue(value.hostRef, host))
      const applicationInstallationId = root.binding.workerInstallationId
      const installationFingerprint = installation?.installationFingerprint
      if (!installation || !installationFingerprint || !applicationInstallationId) continue
      const profiles = await services.profiles.list(host, applicationInstallationId)
      let qualified = false
      for (const profile of profiles.filter(value => matchesConfiguration(value, configuration))) {
        qualified ||= !!await services.registry.profileEvidence(profile)
      }
      if (qualified) continue
      const computer = await this.checkReadiness(() => services.ensureComputerReady?.(host))
      results.set(key, computer.reason === null ? await this.checkReadiness(() =>
        harnessInstances.prepareWorkerConfiguration(principal, source, configuration.harness, {
          hostRef: host, applicationInstallationId,
          harnessInstallationId: installation.harnessInstallationId,
          installationFingerprint,
        })) : computer)
    }
    return results
  }

  /** Every paired computer stays offered: one with no choice above says in plain words why it can't run this Agent.
   * Main is always offered as the workflow default, so only connected computers are listed here. */
  private async unavailableComputers(sql: pg.PoolClient, services: DiscoveryServices,
    configuration: AgentConfigurationVersion, roots: readonly { selection: { hostRef: CanonicalMachineReference } }[],
    choices: readonly NodePlacementChoice[], preparation: ReadonlyMap<string, ComputerAvailability>): Promise<UnavailableComputer[]> {
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
      let reason = preparation.get(commandInputHash(hostRef))?.reason
        ?? `${name} has no ${harness} setup that matches this agent’s model and settings yet.`
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
    const rows = await sql.query<{ record: unknown; policy: unknown }>(`select b.record,p.record as policy from source_root_catalog c
      join source_root_bindings b on b.root_id=c.root_id and b.binding_revision=c.current_binding_revision
      left join workspace_root_policies p on p.root_policy_id::text=b.record#>>'{selection,rootPolicyId}'
        and p.root_policy_revision::text=b.record#>>'{selection,rootPolicyRevision}'
      where c.workspace_id=$1 order by b.record->>'boundAt' desc, c.root_id`, [workspaceId])
    const roots = rows.rows.map(row => ({ root: SourceRootRecordSchema.parse(row.record),
      policy: row.policy ? WorkspaceRootPolicySchema.parse(row.policy) : undefined }))
    return roots.filter(({ root, policy }) => policy?.bindingPurpose !== 'ci-enrollment'
      || !roots.some(other => other.policy && other.policy.bindingPurpose !== 'ci-enrollment'
        && sameWorkflowValue(other.root.selection.hostRef, root.selection.hostRef))).map(({ root }) => root)
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

  private async probeReadiness(services: DiscoveryServices, profiles: HostHarnessOverride[],
    preparation: ReadonlyMap<string, ComputerAvailability>) {
    const computers = new Map<string, ComputerAvailability>()
    const results = new Map<string, ComputerAvailability>()
    for (const profile of profiles) {
      const key = commandInputHash(profile)
      if (results.has(key) || !this.supportedProfile(profile) || !this.installedProfile(services, profile)) continue
      const host = profile.target.hostRef
      const prepared = preparation.get(commandInputHash(host))
      if (prepared?.reason) {
        results.set(key, prepared)
        continue
      }
      const computerKey = commandInputHash({ host, installationId: profile.target.applicationInstallationId })
      let computer = computers.get(computerKey) ?? prepared
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
      return { reason: availability?.reason ?? (error instanceof Error ? error.message : String(error)),
        pending: availability?.pending === true
          || error instanceof DomainError && error.code === 'HARNESS_PROFILE_CHECK_PENDING'
          || error instanceof Error && 'retryable' in error && error.retryable === true }
    }
  }

  private async choice(sql: pg.PoolClient, services: DiscoveryServices, policy: PlacementRootPolicy,
    root: SourceRootRecord | undefined, profile: HostHarnessOverride, rootUnavailableReason: string | null,
    readiness: ReadonlyMap<string, ComputerAvailability>,
  ): Promise<{ choice: NodePlacementChoice; pending: boolean }> {
    const placement = SavedNodePlacementSchema.parse({ schemaVersion: 1, hostRef: policy.hostRef,
      rootPolicyId: policy.rootPolicyId, rootPolicyRevision: policy.rootPolicyRevision,
      locationRevision: policy.locationRevision, projectRoot: policy.canonicalProjectRoot,
      cwdPolicy: 'project-root', relativeCwd: '', instanceId: profile.instanceId,
      instanceRevision: profile.instanceRevision, harnessInstallationId: profile.target.harnessInstallationId,
      ...(root ? { source: root.source, rootBinding: { rootId: root.binding.rootId, bindingRevision: root.binding.bindingRevision } } : {}) })
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
    let folder = basename(policy.canonicalProjectRoot)
    if (policy.bindingPurpose === 'ci-enrollment' && root) {
      const workspace = (await sql.query<{ path: string }>(
        "select execution_location->>'rootPath' as path from workspaces where id=$1", [root.binding.workspaceId])).rows[0]
      folder = basename(workspace?.path ?? 'Project folder')
    }
    const folderLabel = /^[a-f0-9]{32,}$|^[a-f0-9-]{36}$/i.test(folder) ? 'Project folder' : folder
    return { pending, choice: { id: commandInputHash(placement),
      label: `${hostLabel} · ${folderLabel}`,
      placement, availability: reason === null ? 'ready' : 'unavailable', reason } }
  }
}

import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/current'
import { ManagementPrincipalSchema } from '@foreman-code/contracts/management'
import { HostHarnessOverrideSchema } from '@foreman-code/contracts/harness-registry'
import { SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { WorkspaceRootPolicySchema } from '@foreman-code/contracts/workspace-root-policies'
import type { WorkspaceRootPolicyPort } from '../sources/rootPolicyPorts.js'
import type { SourceAdmissionPort } from '../sources/admissionPorts.js'
import type { HarnessInstanceSettingsRepository } from '../harnesses/instanceSettings/repository.js'
import type { ProductionHarnessRegistry } from '../harnesses/productionRegistry.js'
import { DomainError } from '../errors.js'
import { ProductionPlacementChoiceDiscovery } from './choiceDiscovery.js'

function fixture(options: { driver?: 'codex' | 'claude'; host?: 'main' | 'device'
  ensureProfileReady?: (profile: unknown) => Promise<void> } = {}) {
  const workflow = makeCurrentWorkflowFixture('computer-choices', 'single')
  const configuration = workflow.configurations[0]!
  const driver = options.driver ?? 'codex'
  if (driver === 'claude') {
    configuration.harness = { harness: 'claude', model: 'claude-haiku-4-5', authMode: 'subscription',
      configDirectory: '/home/operator/.claude', permissionMode: 'default', sandbox: 'danger-full-access',
      tools: ['Read', 'Write'], permissionRules: [], instructions: '', mcpServers: {} }
  }
  const mainId = randomUUID()
  const deviceId = randomUUID()
  const registration = options.host === 'device'
    ? { workerInstallationId: randomUUID(), keyRevision: 1, authorizationRevision: 1 } : null
  const hostRef = options.host === 'device'
    ? { kind: 'device' as const, mainId, deviceId } : { kind: 'main' as const, mainId }
  const applicationInstallationId = registration?.workerInstallationId ?? mainId
  const rootId = randomUUID()
  const digest = 'a'.repeat(64)
  const principal = ManagementPrincipalSchema.parse({ id: 'owner', name: 'Owner', audience: 'operator',
    expiresAt: '2099-01-01T00:00:00.000Z', revokedAt: null, grants: [] })
  const policy = WorkspaceRootPolicySchema.parse({ schemaVersion: 1, rootPolicyId: randomUUID(),
    rootPolicyRevision: '1', workspaceId: configuration.workspaceId, hostRef,
    applicationInstallationId, registration, locationRevision: '1', ownerPrincipalId: principal.id,
    allowedBaseId: randomUUID(), configurationRevision: '1', relativePath: 'project', accessMode: 'read-write',
    canonicalProjectRoot: '/approved/project', filesystem: { device: '1', inode: '2', mountId: '3' },
    directoryIdentityHash: digest, managedRuntimeRoot: '/runtime',
    runtimeFilesystem: { device: '1', inode: '2', mountId: '3' }, attestationId: randomUUID(), attestationDigest: digest })
  const root = SourceRootRecordSchema.parse({ version: 1,
    source: { approvedSourceId: rootId, snapshotId: rootId, manifestDigest: digest },
    selection: { hostRef: policy.hostRef, rootPolicyId: policy.rootPolicyId,
      rootPolicyRevision: policy.rootPolicyRevision, locationRevision: policy.locationRevision },
    binding: { version: 1, mainId, deviceId: registration ? deviceId : null,
      workerInstallationId: registration?.workerInstallationId ?? null, workspaceId: configuration.workspaceId,
      rootId, bindingRevision: 2, locationRevision: 1, canonicalPath: '/source/namespace',
      filesystem: policy.filesystem, accessMode: 'exclusive-write', snapshotId: rootId, manifestDigest: digest },
    ownerPrincipalId: principal.id, authorizedByPrincipalId: principal.id, registration,
    attestationId: randomUUID(), attestationDigest: digest, boundAt: '2030-01-01T00:00:00.000Z' })
  const profile = HostHarnessOverrideSchema.parse({ instanceId: randomUUID(), revision: 3, instanceRevision: 'profile-3',
    target: { hostRef: policy.hostRef, applicationInstallationId,
      harnessInstallationId: `installed-${driver}`, installationFingerprint: digest },
    presetId: `${driver}-default`, enabled: true, driverId: driver, configuration: configuration.harness,
    configurationFingerprint: digest, qualification: 'qualified' })
  const sourceRoots = vi.fn(async () => [root])
  // The configuration read binds the version id and the workspace id; the source root read binds the workspace id alone.
  const query = vi.fn(async (_sql: string, values: unknown[] = []) => {
    if (values.length === 2 && values[0] === configuration.id) return { rows: [{ record: configuration }] }
    if (values.length === 1 && values[0] === configuration.workspaceId) return { rows: (await sourceRoots()).map(record => ({ record })) }
    return { rows: [] }
  })
  const pool = { connect: async () => ({ query, release: vi.fn() }) } as unknown as pg.Pool
  const readRoots = vi.fn(async () => [policy])
  const resolve = vi.fn(async (_sql: unknown, _principal: unknown, selection: { rootPolicyId: string }) =>
    (await readRoots()).find(value => value.rootPolicyId === selection.rootPolicyId) ?? policy)
  const resolveSource = vi.fn(async (_sql: unknown, _principal: unknown, _input: { rootId: string }) => root)
  const setupRoot = vi.fn(async () => ({ value: root, replayed: false }))
  const profiles = vi.fn(async () => [profile])
  const evidence = vi.fn(async () => ({ qualified: true }))
  const installations = vi.fn(() => [{ hostRef: policy.hostRef, installed: true,
    harnessInstallationId: profile.target.harnessInstallationId, installationFingerprint: digest }])
  const services = {
    roots: { read: readRoots, resolve } as unknown as WorkspaceRootPolicyPort,
    sources: { resolveRootBinding: resolveSource, setupRoot } as unknown as SourceAdmissionPort,
    profiles: { list: profiles } as unknown as HarnessInstanceSettingsRepository,
    registry: { installations: { list: installations }, profileEvidence: evidence } as unknown as
      Pick<ProductionHarnessRegistry, 'installations' | 'profileEvidence'>,
    ...(options.ensureProfileReady ? { ensureProfileReady: options.ensureProfileReady } : {}),
  }
  const input = { workspaceId: configuration.workspaceId, workflowId: workflow.scope.workflowId,
    nodeId: workflow.version.definition.nodes[0]!.id, agentConfigurationVersionId: configuration.id }
  return { service: new ProductionPlacementChoiceDiscovery(pool, () => services), input, principal,
    policy, root, profile, configuration, readRoots, resolve, resolveSource, setupRoot, sourceRoots, profiles, evidence, installations }
}

it('discovers an authorized matching profile with the persisted root, source and revision pins', async () => {
  const f = fixture()
  const choices = (await f.service.list(f.principal, f.input)).choices
  expect(choices).toHaveLength(1)
  expect(choices[0]).toMatchObject({ availability: 'ready', reason: null, label: 'Main · project', placement: {
    hostRef: f.policy.hostRef, projectRoot: f.policy.canonicalProjectRoot, rootPolicyId: f.policy.rootPolicyId,
    rootPolicyRevision: f.policy.rootPolicyRevision, locationRevision: f.policy.locationRevision,
    instanceId: f.profile.instanceId, instanceRevision: f.profile.instanceRevision,
    harnessInstallationId: f.profile.target.harnessInstallationId, source: f.root.source,
    rootBinding: { rootId: f.root.binding.rootId, bindingRevision: 2 },
  } })
  expect(f.resolveSource).toHaveBeenCalledOnce()
  expect(((await f.service.list(f.principal, f.input)).choices)[0]!.id).toBe(choices[0]!.id)
})

it.each(['main', 'device'] as const)('offers one folder choice for identical qualified profiles on %s', async host => {
  const f = fixture({ host })
  const duplicate = { ...f.profile, instanceId: randomUUID() }
  const writable = { ...f.profile, instanceId: randomUUID(),
    configuration: { ...f.profile.configuration, sandbox: 'workspace-write' as const } }
  f.profiles.mockResolvedValue([duplicate, writable, f.profile])

  const result = await f.service.list(f.principal, f.input)

  expect(result.pending).toBe(false)
  expect(result.choices).toHaveLength(1)
  expect([f.profile.instanceId, duplicate.instanceId]).toContain(result.choices[0]!.placement.instanceId)
  expect(result.choices.every(choice => choice.availability === 'ready' && choice.reason === null)).toBe(true)
  expect(new Set(result.choices.map(choice => choice.id)).size).toBe(1)
})

it.each([
  { driver: 'codex', host: 'main', availability: 'ready' },
  { driver: 'codex', host: 'device', availability: 'ready' },
  { driver: 'claude', host: 'main', availability: 'ready' },
  { driver: 'claude', host: 'device', availability: 'unavailable' },
] as const)('matches workflow driver support for $driver on $host', async ({ driver, host, availability }) => {
  const f = fixture({ driver, host })

  const choices = (await f.service.list(f.principal, f.input)).choices

  expect(choices).toHaveLength(1)
  expect(choices[0]).toMatchObject({ availability, placement: { hostRef: f.policy.hostRef } })
  if (availability === 'ready') {
    expect(choices[0]!.reason).toBeNull()
    expect(f.evidence).toHaveBeenCalledOnce()
  } else {
    expect(choices[0]!.reason).toBe('This harness does not support workflow execution on this computer.')
    expect(f.evidence).not.toHaveBeenCalled()
  }
})

it('omits disabled or incompatible profiles and respects a saved profile selection', async () => {
  const f = fixture()
  f.profiles.mockResolvedValue([{ ...f.profile, enabled: false },
    { ...f.profile, configuration: { ...f.configuration.harness, model: 'different-model' } }])
  expect((await f.service.list(f.principal, f.input)).choices).toEqual([])
  f.configuration.harnessProfileSelection = { target: f.profile.target,
    instanceId: randomUUID(), instanceRevision: f.profile.instanceRevision }
  f.profiles.mockResolvedValue([f.profile])
  expect((await f.service.list(f.principal, f.input)).choices).toEqual([])
})

it('uses the retained binding policy after the workspace selects a newer location policy', async () => {
  const f = fixture()
  f.readRoots.mockResolvedValue([{ ...f.policy, rootPolicyRevision: '2', locationRevision: '3' }])

  const choices = (await f.service.list(f.principal, f.input)).choices

  expect(choices).toHaveLength(1)
  expect(choices[0]).toMatchObject({ availability: 'ready', placement: {
    ...f.root.selection, rootBinding: { rootId: f.root.binding.rootId, bindingRevision: 2 },
  } })
  expect(f.resolve).toHaveBeenCalledWith(expect.anything(), f.principal, {
    workspaceId: f.input.workspaceId, ...f.root.selection,
  })
})

it('keeps unqualified installations and revoked root authority unavailable with their reasons', async () => {
  const f = fixture()
  f.installations.mockReturnValue([])
  expect(((await f.service.list(f.principal, f.input)).choices)[0]).toMatchObject({ availability: 'unavailable',
    reason: 'The matching harness profile needs qualification on this computer.' })
  expect(f.evidence).not.toHaveBeenCalled()
  f.resolve.mockRejectedValue(new DomainError('ROOT_DEVICE_CONFLICT', 'Host was revoked.', 403))
  expect((await f.service.list(f.principal, f.input)).choices).toEqual([expect.objectContaining({
    availability: 'unavailable', reason: 'Host was revoked.', placement: expect.objectContaining({
      hostRef: f.root.selection.hostRef, projectRoot: f.root.binding.canonicalPath,
      source: f.root.source,
    }),
  })])
  expect(f.resolveSource).toHaveBeenCalledTimes(1)
  expect(f.evidence).not.toHaveBeenCalled()
})

it('propagates unexpected discovery failures', async () => {
  const f = fixture()
  f.resolve.mockRejectedValue(new Error('database unavailable'))
  await expect(f.service.list(f.principal, f.input)).rejects.toThrow('database unavailable')
})

it.each(['SOURCE_UNAVAILABLE', 'SOURCE_NOT_FOUND', 'SOURCE_ROOT_NOT_FOUND', 'SOURCE_ROOT_CONFLICT'])(
  'automatically repairs %s through source setup and returns the new binding', async code => {
    const f = fixture({ host: 'device' })
    const repaired = structuredClone(f.root)
    repaired.source.snapshotId = randomUUID()
    repaired.binding.snapshotId = repaired.source.snapshotId
    repaired.binding.bindingRevision++
    f.resolveSource.mockRejectedValueOnce(new DomainError(code, 'Source is stale.', 410))
    f.setupRoot.mockImplementation(async () => {
      f.sourceRoots.mockResolvedValue([repaired])
      f.resolveSource.mockResolvedValue(repaired)
      return { value: repaired, replayed: false }
    })

    const result = await f.service.list(f.principal, f.input, 'http')

    expect(result.choices).toEqual([expect.objectContaining({ availability: 'ready', reason: null,
      label: expect.stringContaining(' · project'), placement: expect.objectContaining({ source: repaired.source,
        rootBinding: { rootId: repaired.binding.rootId, bindingRevision: repaired.binding.bindingRevision } }) })])
    expect(f.setupRoot).toHaveBeenCalledWith(f.principal, 'http', expect.objectContaining({
      workspaceId: f.input.workspaceId, selection: f.root.selection, accessMode: f.root.binding.accessMode,
    }))
  })

it('keeps valid sibling folders when source setup fails and shows the actual failure', async () => {
  const f = fixture({ host: 'device' })
  const unavailable = structuredClone(f.root)
  unavailable.binding.rootId = randomUUID()
  unavailable.selection.rootPolicyId = randomUUID()
  f.readRoots.mockResolvedValue([f.policy, { ...f.policy, rootPolicyId: unavailable.selection.rootPolicyId,
    canonicalProjectRoot: '/projects/other' }])
  f.sourceRoots.mockResolvedValue([unavailable, f.root])
  f.resolveSource.mockImplementation(async (_sql, _principal, input) => {
    if (input.rootId === unavailable.binding.rootId) throw new DomainError('SOURCE_UNAVAILABLE', 'Source was released.', 410)
    return f.root
  })
  f.setupRoot.mockRejectedValue(new DomainError('SOURCE_CAPTURE_FAILED', 'The project folder could not be read.', 409))

  const choices = (await f.service.list(f.principal, f.input)).choices

  expect(choices).toHaveLength(2)
  expect(choices[0]).toMatchObject({ availability: 'unavailable', reason: 'The project folder could not be read.',
    placement: { source: unavailable.source, rootBinding: { rootId: unavailable.binding.rootId, bindingRevision: 2 } } })
  expect(choices[1]).toMatchObject({ availability: 'ready', placement: { source: f.root.source } })
})

it('does not try to repair source access denied by the caller’s grants', async () => {
  const f = fixture({ host: 'device' })
  f.resolveSource.mockRejectedValue(new DomainError('ACCESS_DENIED', 'Source access denied.', 403))
  expect((await f.service.list(f.principal, f.input)).choices).toEqual([expect.objectContaining({
    availability: 'unavailable', reason: 'Source access denied.',
  })])
  expect(f.setupRoot).not.toHaveBeenCalled()
})

it('omits CI enrollment namespaces and deduplicates bindings for the same real project folder', async () => {
  const f = fixture({ host: 'device' })
  const ci = structuredClone(f.root)
  ci.binding.rootId = randomUUID()
  ci.selection.rootPolicyId = randomUUID()
  const duplicate = structuredClone(f.root)
  duplicate.binding.rootId = randomUUID()
  duplicate.selection.rootPolicyId = randomUUID()
  f.readRoots.mockResolvedValue([f.policy, { ...f.policy, rootPolicyId: ci.selection.rootPolicyId,
    bindingPurpose: 'ci-enrollment', canonicalProjectRoot: `/managed/${'a'.repeat(64)}` },
  { ...f.policy, rootPolicyId: duplicate.selection.rootPolicyId }])
  f.sourceRoots.mockResolvedValue([ci, f.root, duplicate])

  const choices = (await f.service.list(f.principal, f.input)).choices

  expect(choices).toHaveLength(1)
  expect(choices[0]).toMatchObject({ availability: 'ready', placement: { projectRoot: '/approved/project' } })
})

it('offers the current qualified installation for an unchanged saved profile revision', async () => {
  const f = fixture({ host: 'device' })
  f.configuration.harnessProfileSelection = { instanceId: f.profile.instanceId,
    instanceRevision: f.profile.instanceRevision,
    target: { ...f.profile.target, harnessInstallationId: 'previous', installationFingerprint: 'previous' } }
  expect((await f.service.list(f.principal, f.input)).choices).toEqual([expect.objectContaining({
    availability: 'ready', placement: expect.objectContaining({
      harnessInstallationId: f.profile.target.harnessInstallationId,
      instanceRevision: f.profile.instanceRevision,
    }),
  })])
  f.installations.mockReturnValue([])
  expect((await f.service.list(f.principal, f.input)).choices).toEqual([expect.objectContaining({ availability: 'unavailable' })])
  f.profile.instanceRevision = 'edited'
  expect((await f.service.list(f.principal, f.input)).choices).toEqual([])
})

it('reports discovery as pending while a matching profile check is running', async () => {
  const reason = 'The selected harness profile is being checked. Retry Run start shortly.'
  const ensureProfileReady = vi.fn(async (): Promise<void> => { throw new DomainError('HARNESS_PROFILE_CHECK_PENDING', reason, 503) })
  const f = fixture({ ensureProfileReady })
  const discovered = await f.service.list(f.principal, f.input)
  expect(discovered.pending).toBe(true)
  expect(discovered.choices).toEqual([expect.objectContaining({ availability: 'unavailable', reason })])
  ensureProfileReady.mockResolvedValue(undefined)
  const settled = await f.service.list(f.principal, f.input)
  expect(settled.pending).toBe(false)
  expect(settled.choices).toEqual([expect.objectContaining({ availability: 'ready' })])
})

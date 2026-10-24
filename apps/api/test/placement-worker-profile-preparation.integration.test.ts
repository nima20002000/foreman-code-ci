import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { withAdvancedDefaults } from '@foreman-code/contracts'
import { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HostHarnessInstanceProfileChecks } from '../src/modules/harnesses/instanceSettings/profileChecks.js'
import { deviceHostOverrideAuthority } from '../src/modules/harnesses/instanceSettings/authority.js'
import { OperatorAgentMutationService } from '../src/modules/workspaces/operatorAgents.js'
import { DomainError } from '../src/modules/errors.js'
import { DeviceApplicationError, deviceApplicationFailure } from '../src/modules/devices/index.js'
import { ProductionPlacementChoiceDiscovery } from '../src/modules/placement/choiceDiscovery.js'
import { fixture } from './helpers/nodePlacementStartFixture.js'

it.each(['missing', 'failed', 'matching', 'busy', 'edited', 'edited-other', 'rejected', 'storage-full',
  'target-changed', 'inventory-stale', 'unexpected-qualification', 'unexpected-readiness'] as const)(
  'prepares an exact Worker profile during placement discovery: %s', async scenario => {
    const f = await fixture()
    let checks: HostHarnessInstanceProfileChecks | undefined
    try {
      const saved = await f.save('http')
      const pool = f.base.db.pool
      const principal = f.base.writer.principal
      const profiles = new HarnessInstanceSettingsRepository(pool)
      const proofs = new HostHarnessProfileEvidenceRepository(pool)
      const authority = deviceHostOverrideAuthority(pool)
      const failure = { code: 'MODEL_UNAVAILABLE', message: 'The Worker account cannot use this model.' }
      const storageFailure = new DomainError('HARNESS_RECOVERY_STORAGE_FULL',
        'Native harness storage is full on this computer. Free space in its configured managed storage and retry.', 503)
      const rejectedReason = 'extension-rejected'
      const qualificationError = scenario === 'target-changed' ? new DeviceApplicationError('HARNESS_QUALIFICATION_TARGET_CHANGED')
        : scenario === 'inventory-stale' ? new DeviceApplicationError('HARNESS_INVENTORY_STALE')
        : scenario === 'unexpected-qualification' ? new Error('Worker qualification failed unexpectedly.') : null
      let repaired = false
      const qualify = vi.fn(async (value: Parameters<HostHarnessOverrideService['ensureReady']>[0]) => {
        if (qualificationError) throw qualificationError
        if (scenario === 'rejected') throw new DeviceApplicationError('extension-rejected')
        if (scenario === 'storage-full') throw new DeviceApplicationError(deviceApplicationFailure(storageFailure).code)
        return {
          target: value.target, instanceRevision: value.instanceRevision,
          configurationFingerprint: value.configurationFingerprint, driverId: value.driverId,
          driverRevision: '1', protocolRevision: 'codex-native-adapter-v1', suiteRevision: 'codex-live-4',
          environmentGeneration: '1', connectionGeneration: '1', authenticated: true, compatible: true,
          qualified: scenario !== 'failed' || repaired, ...(scenario === 'failed' && !repaired ? { failure } : {}),
          checkedAt: new Date().toISOString(),
        }
      })
      checks = new HostHarnessInstanceProfileChecks(profiles, proofs, f.base.commands, authority, { qualify })
      const harnessInstances = new HostHarnessOverrideService(profiles, f.base.commands, authority,
        async (value, sql) => {
          const proof = await proofs.latest(value.instanceId, value.revision, sql)
          return proof ? { target: proof.target, configurationFingerprint: proof.configurationFingerprint,
            qualified: proof.qualified, ...(proof.failure ? { failure: proof.failure } : {}) } : null
        }, checks)
      const remote = f.placement.remote.hostRef
      const main = f.placement.local.hostRef
      const installationId = (await pool.query<{ worker_installation_id: string }>(
        'select worker_installation_id from device_registrations where id=$1',
        [remote.kind === 'device' ? remote.deviceId : ''])).rows[0]!.worker_installation_id
      const original = (await profiles.list(remote, installationId))[0]!
      if (original.configuration.harness !== 'codex') throw new Error('Expected a Worker Codex profile')
      if (scenario !== 'matching') {
        await harnessInstances.save(principal, 'http', { instanceId: original.instanceId,
          target: original.target, presetId: original.presetId, enabled: true,
          expectedRevision: original.revision, commandId: randomUUID(),
          configuration: { ...original.configuration, sandbox: 'workspace-write' } })
      }
      const before = await profiles.list(remote, installationId)
      const mainBefore = await profiles.list(main, main.mainId)
      const computerProbes = vi.fn(async (host: typeof main) => {
        if (scenario === 'unexpected-readiness' && host.kind === 'device') throw new Error('Worker inventory lookup failed.')
        if (scenario === 'busy' && host.kind === 'device') {
          throw new DomainError('WORKER_STATUS_UNAVAILABLE', 'The Worker bundle is refreshing.', 503)
        }
      })
      const discovery = new ProductionPlacementChoiceDiscovery(pool, () => ({
        roots: f.placement.policies, sources: f.placement.sources, profiles, harnessInstances,
        registry: { installations: f.placement.installations, profileEvidence: async (value, sql) => {
          const proof = await proofs.latest(value.instanceId, value.revision, sql)
          return proof?.qualified ? proof : null
        } },
        computerOnline: () => true,
        ensureComputerReady: computerProbes,
        ensureProfileReady: value => harnessInstances.ensureReady(value),
      }))
      const input = { workspaceId: saved.version.workspaceId, workflowId: saved.workflowId,
        nodeId: saved.version.definition.nodes[0]!.id,
        agentConfigurationVersionId: f.base.f.configurations[0]!.id }
      const [result, concurrent] = scenario === 'failed'
        ? await discovery.list(principal, input, 'http').then(value => [value, value] as const)
        : await Promise.all([discovery.list(principal, input, 'http'), discovery.list(principal, input, 'mcp')])
      expect(concurrent).toEqual(result)
      if (scenario === 'busy' || scenario === 'unexpected-readiness') {
        expect(result.pending).toBe(scenario === 'busy')
        expect(result.choices.every(choice => choice.placement.hostRef.kind === 'main')).toBe(true)
        expect(result.unavailableComputers).toEqual([expect.objectContaining({
          hostRef: remote, reason: scenario === 'busy' ? 'The Worker bundle is refreshing.' : 'Worker inventory lookup failed.',
        })])
        expect(await profiles.list(remote, installationId)).toEqual(before)
        expect(await profiles.list(main, main.mainId)).toEqual(mainBefore)
        expect(qualify).not.toHaveBeenCalled()
        return
      }
      expect(computerProbes.mock.calls.filter(([host]) => host.kind === 'device')).toHaveLength(scenario === 'failed' ? 1 : 2)
      const worker = result.choices.find(choice => choice.placement.hostRef.kind === 'device')
      const reason = scenario === 'failed' ? failure.message : scenario === 'rejected' ? rejectedReason
        : scenario === 'storage-full' ? 'HARNESS_RECOVERY_STORAGE_FULL' : qualificationError?.message ?? null
      expect(worker).toMatchObject({ availability: reason ? 'unavailable' : 'ready', reason,
        placement: { hostRef: remote, projectRoot: f.placement.remote.projectRoot,
          source: f.placement.remote.source, rootBinding: f.placement.remote.rootBinding } })
      expect(result.pending).toBe(scenario === 'target-changed' || scenario === 'inventory-stale')
      expect(result.unavailableComputers).toEqual([])
      expect(result.choices).toContainEqual(expect.objectContaining({ availability: 'ready', reason: null,
        placement: expect.objectContaining({ hostRef: main }) }))
      const after = await profiles.list(remote, installationId)
      expect(after).toHaveLength(before.length + (scenario === 'matching' ? 0 : 1))
      const selected = after.find(profile => profile.instanceId === worker!.placement.instanceId)!
      expect(withAdvancedDefaults(selected.configuration))
        .toEqual(withAdvancedDefaults(f.base.f.configurations[0]!.harness))
      expect(selected.enabled).toBe(true)
      expect(selected.target).toEqual(original.target)
      expect(await profiles.list(main, main.mainId)).toEqual(mainBefore)
      if (scenario === 'rejected' || scenario === 'storage-full' || qualificationError) {
        expect(qualify).toHaveBeenCalled()
        expect(await discovery.list(principal, input, 'mcp')).toEqual(result)
        expect(await profiles.list(remote, installationId)).toEqual(after)
        return
      }
      if (scenario === 'matching') {
        expect(qualify).not.toHaveBeenCalled()
        expect(selected.instanceId).toBe(original.instanceId)
      } else {
        expect(qualify).toHaveBeenCalledOnce()
        expect(qualify.mock.calls[0]![0].configuration).toEqual(selected.configuration)
        expect(after.find(profile => profile.instanceId === original.instanceId)).toEqual(before[0])
      }
      if (scenario === 'failed') {
        expect(await discovery.list(principal, input, 'mcp')).toEqual(result)
        expect(qualify).toHaveBeenCalledTimes(2)
        repaired = true
        const [ready, concurrentReady] = await Promise.all([
          discovery.list(principal, input, 'http'), discovery.list(principal, input, 'mcp'),
        ])
        expect(concurrentReady).toEqual(ready)
        expect(ready.choices).toContainEqual(expect.objectContaining({ availability: 'ready', reason: null,
          placement: expect.objectContaining({ hostRef: remote, instanceId: selected.instanceId }) }))
        expect(qualify).toHaveBeenCalledTimes(3)
        expect(await discovery.list(principal, input, 'mcp')).toEqual(ready)
        expect(qualify).toHaveBeenCalledTimes(3)
        expect(await profiles.list(remote, installationId)).toEqual(after)
        return
      }
      expect(await discovery.list(principal, input, 'mcp')).toEqual(result)
      expect(await profiles.list(remote, installationId)).toEqual(after)
      expect(qualify).toHaveBeenCalledTimes(scenario === 'matching' ? 0 : 1)
      if (scenario === 'edited' || scenario === 'edited-other') {
        const caller = scenario === 'edited' ? principal : (await f.base.access.issue({
          name: 'Another profile editor', audience: 'operator', grants: principal.grants,
          expiresAt: new Date(Date.now() + 120_000),
        })).principal
        let current = selected
        for (let edit = 0; edit < 2; edit++) {
          if (current.configuration.harness !== 'codex') throw new Error('Expected a generated Codex profile')
          const edited = (await harnessInstances.save(principal, 'mcp', { instanceId: current.instanceId,
            target: current.target, presetId: current.presetId, enabled: true,
            expectedRevision: current.revision, commandId: randomUUID(),
            configuration: { ...current.configuration, sandbox: 'workspace-write' } })).value
          await harnessInstances.check(principal, 'mcp', { instanceId: edited.instanceId, target: edited.target,
            expectedRevision: edited.revision, commandId: randomUUID() })
          const agents = new OperatorAgentMutationService(pool, f.base.commands, f.base.services.harnesses, harnessInstances)
          const otherAgent = (await agents.create(principal, { workspaceId: input.workspaceId, agentId: randomUUID(),
            commandId: randomUUID(), name: 'Agent using the edited profile', configuration: edited.configuration,
            harnessProfileSelection: { instanceId: edited.instanceId, instanceRevision: edited.instanceRevision,
              target: edited.target } })).value.agent
          const otherInput = { ...input, agentConfigurationVersionId: otherAgent.configurationVersionId! }
          const otherChoices = await discovery.list(caller, otherInput, 'mcp')
          expect(otherChoices.choices).toContainEqual(expect.objectContaining({ availability: 'ready', reason: null,
            placement: expect.objectContaining({ instanceId: edited.instanceId, instanceRevision: edited.instanceRevision }) }))
          const restored = await discovery.list(caller, input, 'mcp')
          expect(restored.choices).toContainEqual(expect.objectContaining({ availability: 'ready', reason: null,
            placement: expect.objectContaining({ instanceRevision: '1', hostRef: remote }) }))
          expect(restored.unavailableComputers).toEqual([])
          const latest = await profiles.list(remote, installationId)
          expect(latest).toHaveLength(after.length + edit + 1)
          expect(latest.find(profile => profile.instanceId === edited.instanceId)).toMatchObject({
            revision: edited.revision, configuration: edited.configuration })
          expect(await discovery.list(caller, otherInput, 'http')).toEqual(otherChoices)
          current = latest.find(profile => profile.instanceId === restored.choices.find(choice =>
            choice.placement.hostRef.kind === 'device')!.placement.instanceId)!
          expect(current.instanceId).not.toBe(edited.instanceId)
          expect(current.configuration).toEqual(selected.configuration)
          expect(await discovery.list(caller, input, 'http')).toEqual(restored)
          expect(await profiles.list(remote, installationId)).toEqual(latest)
          expect(qualify).toHaveBeenCalledTimes(2 * edit + 3)
        }
        expect(await profiles.list(main, main.mainId)).toEqual(mainBefore)
      }
    } finally {
      await checks?.close()
      await f.close()
    }
  }, 120_000)

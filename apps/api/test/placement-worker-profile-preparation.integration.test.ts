import { randomUUID } from 'node:crypto'
import { expect, it, vi } from 'vitest'
import { withAdvancedDefaults } from '@foreman-code/contracts'
import { HostHarnessOverrideService } from '../src/modules/harnesses/instanceSettings/service.js'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { HostHarnessInstanceProfileChecks } from '../src/modules/harnesses/instanceSettings/profileChecks.js'
import { deviceHostOverrideAuthority } from '../src/modules/harnesses/instanceSettings/authority.js'
import { ProductionPlacementChoiceDiscovery } from '../src/modules/placement/choiceDiscovery.js'
import { fixture } from './helpers/nodePlacementStartFixture.js'

it.each(['missing', 'failed', 'matching'] as const)(
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
      const qualify = vi.fn(async (value: Parameters<HostHarnessOverrideService['ensureReady']>[0]) => ({
        target: value.target, instanceRevision: value.instanceRevision,
        configurationFingerprint: value.configurationFingerprint, driverId: value.driverId,
        driverRevision: '1', protocolRevision: 'codex-native-adapter-v1', suiteRevision: 'codex-live-4',
        environmentGeneration: '1', connectionGeneration: '1', authenticated: true, compatible: true,
        qualified: scenario !== 'failed', ...(scenario === 'failed' ? { failure } : {}),
        checkedAt: new Date().toISOString(),
      }))
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
      if (scenario !== 'matching') {
        await harnessInstances.save(principal, 'http', { instanceId: original.instanceId,
          target: original.target, presetId: original.presetId, enabled: true,
          expectedRevision: original.revision, commandId: randomUUID(),
          configuration: { ...original.configuration, sandbox: 'workspace-write' } })
      }
      const before = await profiles.list(remote, installationId)
      const mainBefore = await profiles.list(main, main.mainId)
      const discovery = new ProductionPlacementChoiceDiscovery(pool, () => ({
        roots: f.placement.policies, sources: f.placement.sources, profiles, harnessInstances,
        registry: { installations: f.placement.installations, profileEvidence: async (value, sql) => {
          const proof = await proofs.latest(value.instanceId, value.revision, sql)
          return proof?.qualified ? proof : null
        } },
        computerOnline: () => true,
        ensureProfileReady: value => harnessInstances.ensureReady(value),
      }))
      const input = { workspaceId: saved.version.workspaceId, workflowId: saved.workflowId,
        nodeId: saved.version.definition.nodes[0]!.id,
        agentConfigurationVersionId: f.base.f.configurations[0]!.id }
      const [result, concurrent] = await Promise.all([
        discovery.list(principal, input, 'http'), discovery.list(principal, input, 'mcp'),
      ])
      expect(concurrent).toEqual(result)
      const worker = result.choices.find(choice => choice.placement.hostRef.kind === 'device')
      expect(worker).toMatchObject({ availability: scenario === 'failed' ? 'unavailable' : 'ready',
        reason: scenario === 'failed' ? failure.message : null,
        placement: { hostRef: remote, projectRoot: f.placement.remote.projectRoot,
          source: f.placement.remote.source, rootBinding: f.placement.remote.rootBinding } })
      expect(result.pending).toBe(false)
      expect(result.unavailableComputers).toEqual([])
      const after = await profiles.list(remote, installationId)
      expect(after).toHaveLength(before.length + (scenario === 'matching' ? 0 : 1))
      const selected = after.find(profile => profile.instanceId === worker!.placement.instanceId)!
      expect(withAdvancedDefaults(selected.configuration))
        .toEqual(withAdvancedDefaults(f.base.f.configurations[0]!.harness))
      expect(selected.enabled).toBe(true)
      expect(selected.target).toEqual(original.target)
      expect(await profiles.list(main, main.mainId)).toEqual(mainBefore)
      if (scenario === 'matching') {
        expect(qualify).not.toHaveBeenCalled()
        expect(selected.instanceId).toBe(original.instanceId)
      } else {
        expect(qualify).toHaveBeenCalledOnce()
        expect(qualify.mock.calls[0]![0].configuration).toEqual(selected.configuration)
        expect(after.find(profile => profile.instanceId === original.instanceId)).toEqual(before[0])
      }
      expect(await discovery.list(principal, input, 'mcp')).toEqual(result)
      expect(await profiles.list(remote, installationId)).toEqual(after)
      expect(qualify).toHaveBeenCalledTimes(scenario === 'matching' ? 0 : 1)
    } finally {
      await checks?.close()
      await f.close()
    }
  }, 120_000)

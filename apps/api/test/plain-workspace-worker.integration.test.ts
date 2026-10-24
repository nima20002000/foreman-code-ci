import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { CurrentWorkflowSaveResultSchema } from '@foreman-code/contracts/current'
import { readdir, stat } from 'node:fs/promises'
import { ManagedWorkspaceRootService } from '../src/modules/workspace-roots/managedRoot.js'
import { WorkspaceBoundLocationService } from '../src/modules/workspace-roots/service.js'
import { randomUUID } from 'node:crypto'
import { describe, expect, it } from 'vitest'
import { NodePlacementChoicesResultSchema } from '@foreman-code/contracts/placement-readback'
import { HarnessInstanceSettingsRepository } from '../src/modules/harnesses/instanceSettings/repository.js'
import { HostHarnessProfileEvidenceRepository } from '../src/modules/harnesses/instanceSettings/profileRepository.js'
import { ProductionPlacementChoiceDiscovery } from '../src/modules/placement/choiceDiscovery.js'
import { NodePlacementChoicesService } from '../src/modules/placement/choicesService.js'
import { buildApp } from '../src/app.js'
import { fixture, startInput } from './helpers/nodePlacementStartFixture.js'
import { agentWorkflowNode } from './helpers/agentWorkflowFixture.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { sourceSha256 } from '../src/modules/sources/manifest.js'
import { postgresEnabled } from './helpers/database.js'

describe.skipIf(!postgresEnabled)('plain workspace Worker placement', () => {
  it.each([
    { managed: false, mixed: false }, { managed: true, mixed: false }, { managed: true, mixed: true },
  ])('sets up an empty folder, discovers the Worker and accepts its Run (managed: $managed, mixed: $mixed)', async ({ managed, mixed }) => {
    const f = await fixture({ plainWorkspace: true, physicalWorker: managed, unconfiguredFirstDeviceRoot: managed })
    let app: ReturnType<typeof buildApp> | undefined
    try {
      const workspaceId = f.saveInput.workspaceId
      const pool = f.base.db.pool
      const folders = new ManagedWorkspaceRootService(f.base.commands,
        new WorkspaceBoundLocationService(pool, f.base.commands, f.placement.policies), f.placement.policies)
      f.placement.sources.setupFolder = (principal, source, workspaceId, target) => folders.ensure(principal, source, workspaceId, target)
      expect(await readdir(f.placement.local.projectRoot)).toEqual([])
      const evidence = new HostHarnessProfileEvidenceRepository(pool)
      const discovery = new ProductionPlacementChoiceDiscovery(pool, () => ({
        roots: f.placement.policies, sources: f.placement.sources,
        profiles: new HarnessInstanceSettingsRepository(pool),
        registry: { installations: f.placement.installations,
          profileEvidence: (profile, sql) => evidence.latest(profile.instanceId, profile.revision, sql) },
      }))
      app = buildApp({ logger: false,
        readiness: { database: { ping: async () => undefined }, checkpoints: { ping: async () => undefined } },
        operator: { access: f.base.access, services: { ...f.services,
          placementChoices: new NodePlacementChoicesService(pool, discovery) } },
      })
      const setup = await app.inject({ method: 'POST',
        url: `/api/management/workspaces/${workspaceId}/source-roots/setup`, headers: f.headers,
        payload: managed ? { workspaceId, commandId: randomUUID(), hostRef: f.placement.remote.hostRef }
          : { workspaceId, commandId: randomUUID(), selection: {
          hostRef: f.placement.remote.hostRef, rootPolicyId: f.placement.remote.rootPolicyId,
          rootPolicyRevision: f.placement.remote.rootPolicyRevision, locationRevision: f.placement.remote.locationRevision,
        }, accessMode: 'exclusive-write' },
      })
      expect(setup.statusCode, setup.body).toBe(200)
      expect(setup.json().value).toMatchObject({ kind: 'plain', policy: {
        hostRef: f.placement.remote.hostRef,
      } })
      if (managed) {
        const folder = setup.json().value.policy.canonicalProjectRoot as string
        expect(folder.startsWith(`${f.placement.remote.projectRoot}/`)).toBe(true)
        expect((await stat(folder)).isDirectory()).toBe(true)
        expect(await readdir(folder)).toEqual([])
        const repeated = await f.placement.sources.setupRoot(f.base.writer.principal, 'http', {
          workspaceId, commandId: randomUUID(), hostRef: f.placement.remote.hostRef,
        })
        expect(repeated.value).toEqual(setup.json().value)
      }
      delete agentWorkflowNode(f.saveInput.graph.nodes[1]).placement
      const saved = await f.save('mcp')
      const node = agentWorkflowNode(saved.version.definition.nodes[1])
      const result = await app.inject({ method: 'GET', headers: f.headers,
        url: `${f.path}/nodes/${node.id}/placement-choices?agentConfigurationVersionId=${saved.version.agentConfigurationVersionIds[node.agentId]}` })
      expect(result.statusCode, result.body).toBe(200)
      const choice = NodePlacementChoicesResultSchema.parse(result.json()).choices.find(choice =>
        choice.placement.hostRef.kind === 'device')!
      expect(choice).toMatchObject({ availability: 'ready', reason: null })
      expect(choice.placement).not.toHaveProperty('source')
      expect(choice.placement).not.toHaveProperty('rootBinding')
      for (const item of mixed ? f.saveInput.graph.nodes.slice(1) : f.saveInput.graph.nodes) {
        agentWorkflowNode(item).placement = choice.placement
      }
      f.saveInput.expectedRevision = saved.revision
      f.saveInput.commandId = randomUUID()
      const selectedResult = await f.client.callTool({ name: 'workflow_save_v3', arguments: {
        ...f.saveInput, expectedWorkflowVersionId: saved.currentVersionId,
      } })
      expect(selectedResult.isError, JSON.stringify(selectedResult)).not.toBe(true)
      const selected = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(selectedResult)).value
      expect((await f.placement.policies.read(pool, f.base.writer.principal, workspaceId))
        .some(policy => policy.hostRef.kind === 'main')).toBe(false)
      const accepted = await f.start('mcp', startInput(f, selected))
      expect(accepted.run.workflowVersionId).toBe(selected.currentVersionId)
      expect(accepted.run.executionLocation).toMatchObject({
        rootPath: f.placement.local.projectRoot, locationRevision: f.placement.locationRevision,
      })
      for (const item of selected.version.definition.nodes) {
        const placement = await f.placement.reads.get(f.base.writer.principal, {
          workspaceId, workflowId: selected.workflowId, runId: accepted.run.id, nodeId: item.id,
        })
        const expected = mixed && item.id === selected.version.definition.nodes[0]!.id
          ? f.placement.local : choice.placement
        expect(placement.readback).toMatchObject({ evidence: 'accepted',
          placement: { hostRef: expected.hostRef, source: { kind: 'plain' },
            destination: { canonicalCwd: expected.projectRoot } } })
      }
      expect((await pool.query('select 1 from source_root_catalog where workspace_id=$1', [workspaceId])).rowCount).toBe(0)
      expect((await pool.query('select 1 from source_snapshots where workspace_id=$1', [workspaceId])).rowCount).toBe(0)
    } finally { await app?.close(); await f.close() }
  }, 120_000)

  it.each(['revoked', 'configuration changed'] as const)('keeps healthy plain-folder choices when another Worker is %s', async failure => {
    const f = await fixture({ plainWorkspace: true, deviceCount: 2 })
    try {
      delete agentWorkflowNode(f.saveInput.graph.nodes[1]).placement
      const saved = await f.save('mcp')
      const pool = f.base.db.pool
      const evidence = new HostHarnessProfileEvidenceRepository(pool)
      const choices = new NodePlacementChoicesService(pool, new ProductionPlacementChoiceDiscovery(pool, () => ({
        roots: f.placement.policies, sources: f.placement.sources,
        profiles: new HarnessInstanceSettingsRepository(pool),
        registry: { installations: f.placement.installations,
          profileEvidence: (profile, sql) => evidence.latest(profile.instanceId, profile.revision, sql) },
      })))
      const node = agentWorkflowNode(saved.version.definition.nodes[1])
      const input = { workspaceId: saved.version.workspaceId, workflowId: saved.workflowId, nodeId: node.id,
        agentConfigurationVersionId: saved.version.agentConfigurationVersionIds[node.agentId] }
      const before = await choices.get(f.base.writer.principal, input)
      expect(before.choices.filter(choice => choice.availability === 'ready')).toHaveLength(2)
      const host = f.placement.remote.hostRef
      if (host.kind !== 'device') throw new Error('Expected Worker')
      if (failure === 'revoked') {
        await pool.query("update device_registrations set record=jsonb_set(record,'{status}',to_jsonb('revoked'::text)) where id=$1", [host.deviceId])
      } else {
        await withTransaction(pool, async sql => {
          const configuration = await f.placement.hosts.configuration(sql, host)
          const changed = { ...configuration, configurationRevision: '2' }
          await f.placement.policies.publishApprovedHostConfiguration(sql, changed, {
            mainId: host.mainId, hostRef: host, applicationInstallationId: changed.applicationInstallationId,
            configurationRevision: changed.configurationRevision,
            configurationDigest: sourceSha256(Buffer.from(JSON.stringify(changed))),
          })
        })
      }
      const result = await choices.get(f.base.writer.principal, input)
      expect(result.choices).toContainEqual(expect.objectContaining({ availability: 'ready', reason: null,
        placement: expect.objectContaining({ hostRef: f.placement.remotes[1]!.hostRef }) }))
      expect(result.choices).toContainEqual(expect.objectContaining({ availability: 'unavailable',
        reason: failure === 'revoked' ? 'Device access rejected: revoked'
          : 'The accepted root no longer has current host/configuration authority.',
        placement: expect.objectContaining({ hostRef: host }) }))
      expect(result.pending).toBe(false)
    } finally { await f.close() }
  }, 120_000)

})

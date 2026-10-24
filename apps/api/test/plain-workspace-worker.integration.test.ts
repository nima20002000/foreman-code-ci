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
import { postgresEnabled } from './helpers/database.js'

describe.skipIf(!postgresEnabled)('plain workspace Worker placement', () => {
  it('sets up an empty folder, discovers Paired computer and accepts its Run without capturing source', async () => {
    const f = await fixture()
    let app: ReturnType<typeof buildApp> | undefined
    try {
      const workspaceId = f.saveInput.workspaceId
      const pool = f.base.db.pool
      await pool.query("update workspaces set record=record-'repository' where id=$1", [workspaceId])
      await pool.query('delete from source_root_bindings where workspace_id=$1', [workspaceId])
      await pool.query('delete from source_root_catalog where workspace_id=$1', [workspaceId])
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
        payload: { workspaceId, commandId: randomUUID(), selection: {
          hostRef: f.placement.remote.hostRef, rootPolicyId: f.placement.remote.rootPolicyId,
          rootPolicyRevision: f.placement.remote.rootPolicyRevision, locationRevision: f.placement.remote.locationRevision,
        }, accessMode: 'exclusive-write' },
      })
      expect(setup.statusCode, setup.body).toBe(200)
      expect(setup.json().value).toMatchObject({ kind: 'plain', policy: {
        hostRef: f.placement.remote.hostRef, canonicalProjectRoot: f.placement.remote.projectRoot,
      } })
      const saved = await f.save('http')
      const node = agentWorkflowNode(saved.version.definition.nodes[1])
      const result = await app.inject({ method: 'GET', headers: f.headers,
        url: `${f.path}/nodes/${node.id}/placement-choices?agentConfigurationVersionId=${saved.version.agentConfigurationVersionIds[node.agentId]}` })
      expect(result.statusCode, result.body).toBe(200)
      const choice = NodePlacementChoicesResultSchema.parse(result.json()).choices.find(choice =>
        choice.placement.hostRef.kind === 'device')!
      expect(choice).toMatchObject({ availability: 'ready', reason: null })
      expect(choice.placement).not.toHaveProperty('source')
      expect(choice.placement).not.toHaveProperty('rootBinding')
      for (const item of f.saveInput.graph.nodes) agentWorkflowNode(item).placement = choice.placement
      f.saveInput.expectedRevision = saved.revision
      f.saveInput.expectedWorkflowVersionId = saved.currentVersionId
      f.saveInput.commandId = randomUUID()
      const selected = await f.save('http')
      const accepted = await f.start('http', startInput(f, selected))
      expect(accepted.run.workflowVersionId).toBe(selected.currentVersionId)
      for (const item of selected.version.definition.nodes) {
        const placement = await f.placement.reads.get(f.base.writer.principal, {
          workspaceId, workflowId: selected.workflowId, runId: accepted.run.id, nodeId: item.id,
        })
        expect(placement.readback).toMatchObject({ evidence: 'accepted',
          placement: { hostRef: choice.placement.hostRef, source: { kind: 'plain' },
            destination: { canonicalCwd: choice.placement.projectRoot } } })
      }
      expect((await pool.query('select 1 from source_root_catalog where workspace_id=$1', [workspaceId])).rowCount).toBe(0)
    } finally { await app?.close(); await f.close() }
  }, 120_000)
})

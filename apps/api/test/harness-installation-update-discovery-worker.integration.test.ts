import { describe, expect, it } from 'vitest'
import { RunPlacementGetResultSchema } from '@foreman-code/contracts/placement-readback'
import { ApprovedSourceSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { installationUpdateFixture, profileReader, profiles, startWhenReady, completedRun }
  from './helpers/harnessInstallationUpdate.js'

describe('installed harness updates', () => {
  it('cancels Start during required Worker discovery without canceling its shared refresh or persisting a Run', async () => {
    const fixture = await installationUpdateFixture({ workflow: 'single', executionHost: 'worker' })
    try {
      const reader = await profileReader(fixture)
      await fixture.blockWorkerDiscovery()
      await expect(fixture.start()).rejects.toThrow('RUN_START_PREPARATION_TIMEOUT')
      expect((await fixture.db.pool.query('select id from runs')).rows).toEqual([])
      expect((await profiles(fixture, reader))[0]!.qualification).toBe('qualified')
      await fixture.releaseWorkerDiscovery()
      const started = (await startWhenReady(fixture))!
      expect(fixture.sourceManifest.git?.repository).toBe(fixture.repositoryName)
      const { workspaceId, workflowId } = fixture.version
      const { readback } = RunPlacementGetResultSchema.parse(await fixture.value('run_node_placement_get', {
        workspaceId, workflowId, runId: started.run.id, nodeId: fixture.version.definition.nodes[0]!.id,
      }))
      expect(readback.evidence).toBe('accepted')
      if (readback.evidence !== 'accepted') throw new Error('Run placement was not accepted.')
      expect(readback.placement.hostRef).toEqual(fixture.hostRef)
      const source = readback.placement.source
      expect(source).toMatchObject({ kind: 'pending' })
      if (!('kind' in source)) throw new Error('Run source was not pinned for lazy materialization.')
      const pin = { approvedSourceId: source.approvedSourceId,
        snapshotId: source.snapshotId, manifestDigest: source.manifestDigest }
      const approved = ApprovedSourceSchema.parse(await fixture.value('source_get', { workspaceId, ...pin }))
      expect(approved.manifest).toMatchObject({ ...pin,
        git: { repository: fixture.repositoryName, commit: fixture.sourceManifest.git!.commit },
        entries: fixture.sourceManifest.entries,
        executablePolicy: fixture.sourceManifest.executablePolicy,
      })
      const root = SourceRootRecordSchema.parse(await fixture.value('source_root_get', {
        workspaceId, rootId: source.rootId, bindingRevision: source.bindingRevision,
      }))
      expect(root.source).toEqual(pin)
      expect(root.selection.hostRef).toEqual(fixture.hostRef)
      await completedRun(fixture, started.run.id)
    } finally {
      await fixture.releaseWorkerDiscovery()
      await fixture.close()
    }
  }, 240_000)
})

import { describe, expect, it } from 'vitest'
import { ApprovedSourceSchema, SourceRootRecordSchema } from '@foreman-code/contracts/source-admission'
import { installationUpdateFixture, profileReader, profiles, startWhenReady, pinnedPlacements, completedRun }
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
      const placements = await pinnedPlacements(fixture, started.run.id)
      expect(placements).toHaveLength(1)
      const placement = placements[0]!
      expect(placement.hostRef).toEqual(fixture.hostRef)
      if (!('kind' in placement.source)) throw new Error('Expected an accepted source awaiting materialization.')
      const root = SourceRootRecordSchema.parse(await fixture.value('source_root_get', {
        workspaceId: fixture.version.workspaceId, rootId: placement.source.rootId,
        bindingRevision: placement.source.bindingRevision,
      }))
      expect(placement.source).toMatchObject(root.source)
      const source = ApprovedSourceSchema.parse(await fixture.value('source_get', {
        workspaceId: fixture.version.workspaceId, ...root.source,
      }))
      expect(source.manifest.git).toEqual(fixture.sourceManifest.git)
      expect(source.manifest.entries).toEqual(fixture.sourceManifest.entries)
      expect(source.manifest.snapshotId).not.toBe(fixture.sourceManifest.snapshotId)
      await completedRun(fixture, started.run.id)
    } finally {
      await fixture.releaseWorkerDiscovery()
      await fixture.close()
    }
  }, 240_000)
})

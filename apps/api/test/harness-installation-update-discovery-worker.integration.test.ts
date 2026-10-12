import { describe, expect, it } from 'vitest'
import { ApprovedSourceSchema } from '@foreman-code/contracts/source-admission'
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
      expect(placements[0]!.hostRef).toEqual(fixture.hostRef)
      const source = placements[0]!.source
      if (!('kind' in source) || source.kind !== 'pending') {
        throw new Error('Run Start must retain its approved source pins')
      }
      const approved = ApprovedSourceSchema.parse(await fixture.value('source_get', {
        workspaceId: fixture.version.workspaceId, approvedSourceId: source.approvedSourceId,
        snapshotId: source.snapshotId, manifestDigest: source.manifestDigest,
      }))
      expect(approved.manifest.git).toEqual(fixture.sourceManifest.git)
      expect(approved.manifest.entries).toEqual(fixture.sourceManifest.entries)
      expect(source.manifestDigest).toBe(approved.manifest.manifestDigest)
      await completedRun(fixture, started.run.id)
    } finally {
      await fixture.releaseWorkerDiscovery()
      await fixture.close()
    }
  }, 240_000)
})

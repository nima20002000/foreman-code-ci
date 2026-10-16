import { execFile, spawn } from 'node:child_process'
import { cpus } from 'node:os'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { fileURLToPath } from 'node:url'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { HostHarnessOverrideListSchema } from '@foreman-code/contracts/harness-registry'
import { HarnessQualificationListSchema } from '@foreman-code/contracts/harness-qualification'
import { waitForRemoteReview } from './helpers/remoteReviewProduction.js'
import { installationUpdateFixture } from './helpers/harnessInstallationUpdate.js'
import { latestEvidence } from './helpers/workerProfileRequalification.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'

const execute = promisify(execFile)

describe('automatic Worker profile qualification', () => {
  it('builds the committed Worker execution graph and starts its packaged CLI', async () => {
    const directory = await privateFixtureDirectory('worker-qualification-artifact-')
    try {
      const repository = fileURLToPath(new URL('../../../', import.meta.url))
      const release = join(directory, 'release')
      await execute(process.execPath, [join(repository, 'scripts/build-worker-artifact.mjs'),
        'apps/worker/artifacts/ubuntu-26.04-x64-target.json', release],
      { cwd: repository, maxBuffer: 4 * 1024 * 1024 })
      const { stdout } = await execute(process.execPath, [join(release, 'src/cli.mjs'), '--help'])
      expect(stdout).toContain('graphql-worker run|doctor|identity-request|initialize-native-runtime')
    } finally {
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it('persists a failed automatic check and refuses Start without borrowing the previous installation', async () => {
    const fixture = await installationUpdateFixture({ workflow: 'sequential' })
    const burners = Array.from({ length: cpus().length * 2 }, () => spawn(process.execPath, ['-e', 'for(;;);'], { stdio: 'ignore' }))
    try {
      const before = await latestEvidence(fixture)
      expect(before).toHaveLength(fixture.profiles.length)
      expect(before.every(proof => proof.qualified)).toBe(true)
      await fixture.provider.hideModels()
      await fixture.provider.updatePayload()
      const t0 = Date.now()
      let evidence: Awaited<ReturnType<typeof latestEvidence>>
      try {
        evidence = await waitForRemoteReview(() => latestEvidence(fixture), proofs =>
          proofs.length === fixture.profiles.length && proofs.every(proof =>
            proof.target.installationFingerprint !== before[0]!.target.installationFingerprint && !proof.qualified),
        'persisted failed automatic profile checks')
      } catch (error) {
        const rows = await fixture.db.pool.query(`select instance_id,instance_revision,created_at,record->'target'->>'installationFingerprint' fp,record->>'qualified' q,record->'failure'->>'code' code from harness_instance_profile_evidence order by created_at`)
        const settings = await fixture.db.pool.query(`select instance_id,revision,record->'target'->>'installationFingerprint' fp from harness_instance_settings order by instance_id,revision`)
        const audit = await fixture.db.pool.query(`select sequence,action,outcome,details from management_audit where action like 'harness.%' order by sequence`)
        const inv = await fixture.inventory().then(v => v.installations.map(i => [i.driverId, i.installationFingerprint, i.installed, i.observedVersion, i.connectionGeneration]), e => String(e))
        const profs = await fixture.value('harness_instances_list', { hostRef: fixture.hostRef, applicationInstallationId: fixture.profiles[0]!.target.applicationInstallationId }).then(v => JSON.stringify(v).slice(0, 1500), e => String(e))
        throw new Error(`DIAG ${JSON.stringify({ failures: fixture.failures(), inv, profs, rows: rows.rows, settings: settings.rows, audit: audit.rows, before: before.map(b => b.target.installationFingerprint) })} ${String(error)}`)
      }
      console.log(`DIAG failed evidence after ${Date.now() - t0} ms`)
      expect(evidence.every(proof => proof.failure !== undefined)).toBe(true)
      // Drain independent readbacks before fixture cleanup can stop the Worker.
      const results = await Promise.allSettled([
        waitForRemoteReview(async () => HostHarnessOverrideListSchema.parse(
          await fixture.value('harness_instances_list', { hostRef: fixture.hostRef,
            applicationInstallationId: fixture.profiles[0]!.target.applicationInstallationId })),
        value => value.overrides.every(profile => profile.qualification === 'unqualified'), 'unqualified MCP readback'),
        waitForRemoteReview(async () => {
          try { await fixture.start() } catch (error) { return error }
          throw new Error('A failed profile check admitted a Run.')
        }, error => error instanceof Error && error.message.includes(evidence[0]!.failure!.code),
        'Run refusal after the failed automatic check'),
        fixture.value('harness_qualifications_list', {}).then(result => HarnessQualificationListSchema.parse(result)),
      ])
      const errors = results.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
      if (errors.length) throw new AggregateError(errors, 'Failed automatic profile check readback failed.')
      const value = <T,>(result: PromiseSettledResult<T>): T => {
        if (result.status === 'rejected') throw result.reason
        return result.value
      }
      const profiles = value(results[0])
      const refusal = value(results[1])
      const qualifications = value(results[2])
      expect(profiles.overrides).toHaveLength(fixture.profiles.length)
      expect(refusal).toBeInstanceOf(Error)
      expect((await fixture.db.pool.query('select id from runs')).rows).toEqual([])
      expect(qualifications.qualifications.some(record => record.status === 'failed'
        && evidence.some(proof => proof.checkedAt === record.checkedAt))).toBe(true)
    } finally { for (const b of burners) b.kill('SIGKILL'); await fixture.close() }
  }, 240_000)
})

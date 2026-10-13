import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { HostHarnessOverrideSaveResultSchema, HostHarnessInstanceCheckResultSchema, HostHarnessProfileEvidenceSchema }
  from '@foreman-code/contracts/harness-registry'
import { localWorkflowSourceClosed } from '../../src/modules/sources/workflowCleanup.js'
import {
  installationUpdateFixture, profileReader, profiles, runningTurn, pinnedPlacements, startWhenReady,
  completedRun, latestEvidence, waitForInstallationUpdate,
} from './harnessInstallationUpdate.js'

export async function assertResidentRunAcrossUnavailableInstallation(executionHost: 'main' | 'worker') {
  const fixture = await installationUpdateFixture({ workflow: 'single', executionHost })
  let blocked = false
  try {
    const reader = await profileReader(fixture)
    const before = (await profiles(fixture, reader))[0]!
    await fixture.provider.blockWorkflowTurns()
    blocked = true
    const started = await fixture.start()
    const turn = await runningTurn(fixture)
    const pins = await pinnedPlacements(fixture, started.run.id)
    await fixture.provider.removePayload()
    const unavailable = await waitForInstallationUpdate(() => fixture.inventory(), value =>
      value.installations.some(installation => installation.driverId === 'codex'
        && !installation.installed && installation.installationFingerprint === null),
      'unavailable intermediate inventory')
    expect(unavailable.installations.find(installation => installation.driverId === 'codex')).toMatchObject({
      harnessInstallationId: before.target.harnessInstallationId,
      installed: false,
      installationFingerprint: null,
    })
    await waitForInstallationUpdate(() => profiles(fixture, reader), values => values.every(value =>
      value.qualification === 'unqualified' && value.qualificationFailure !== undefined), 'unavailable profile readback')
    await expect(fixture.start()).rejects.toThrow('HARNESS_INSTALLATION_INVALID')
    expect(process.kill(turn.pid, 0)).toBe(true)
    await fixture.provider.updatePayload()
    await waitForInstallationUpdate(() => profiles(fixture, reader), values => values.every(value =>
      value.qualification === 'qualified' && value.target.installationFingerprint !== before.target.installationFingerprint),
    'qualified replacement after missing inventory')
    const next = (await startWhenReady(fixture))!
    await fixture.provider.releaseWorkflowTurns()
    blocked = false
    await completedRun(fixture, started.run.id)
    await completedRun(fixture, next.run.id)
    if (executionHost === 'main') {
      const executions = await fixture.db.pool.query<{ id: string }>(
        'select id from harness_executions where run_id=any($1::text[])', [[started.run.id, next.run.id]])
      expect(executions.rows).toHaveLength(2)
      for (const execution of executions.rows) {
        expect(await localWorkflowSourceClosed(fixture.db.pool, execution.id)).toBe(true)
      }
    }
    expect(await pinnedPlacements(fixture, started.run.id)).toEqual(pins)
    expect(await fixture.provider.calls()).toContainEqual({ workflowCompleted: turn })
    expect((await pinnedPlacements(fixture, next.run.id))[0]!.payload).toMatchObject({
      installationFingerprint: (await profiles(fixture, reader))[0]!.target.installationFingerprint,
    })
  } finally {
    if (blocked) await fixture.provider.releaseWorkflowTurns()
    await fixture.close()
  }
}

export async function assertUpdatedInstallationProfiles(executionHost: 'main' | 'worker') {
  const fixture = await installationUpdateFixture({ workflow: 'single', executionHost })
  let modelsBlocked = false
  let turnsBlocked = false
  try {
    const configured = fixture.profiles[0]!
    const additional = HostHarnessOverrideSaveResultSchema.parse(await fixture.value('harness_instance_save', {
      commandId: randomUUID(), instanceId: randomUUID(), expectedRevision: 0, target: configured.target,
      presetId: configured.presetId, enabled: true, configuration: configured.configuration,
    })).value
    const checked = HostHarnessInstanceCheckResultSchema.parse(await fixture.value('harness_instance_check', {
      commandId: randomUUID(), instanceId: additional.instanceId,
      expectedRevision: additional.revision, target: additional.target,
    }))
    expect(checked.proof.qualified).toBe(true)
    const before = await profiles(fixture)
    expect(before).toHaveLength(2)
    const oldFingerprint = before[0]!.target.installationFingerprint
    const oldProofs = await latestEvidence(fixture)
    await fixture.provider.blockWorkflowTurns()
    turnsBlocked = true
    const oldRun = await fixture.start()
    const original = await waitForInstallationUpdate(() => fixture.provider.calls(), calls =>
      calls.some(call => call.workflowTurn !== undefined), 'the original native turn')
    const turn = original.find(call => call.workflowTurn !== undefined)!.workflowTurn as {
      pid: number; sessionId: string; turnId: string
    }
    expect(process.kill(turn.pid, 0)).toBe(true)
    await fixture.provider.blockModels()
    modelsBlocked = true
    await fixture.provider.updatePayload()
    await waitForInstallationUpdate(() => profiles(fixture), values =>
      values.length === before.length && values.every(value => value.qualification === 'qualifying'),
    'automatic installation check pending in MCP readback')
    await expect(fixture.start()).rejects.toThrow('HARNESS_PROFILE_CHECK_PENDING')
    expect(process.kill(turn.pid, 0)).toBe(true)

    const reader = await fixture.access.issue({ name: 'Installation profile reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['harnesses:read'], scope: {} }] })
    const pending = await profiles(fixture, reader.token)
    const profile = pending[0]!
    const denied = await fixture.call('harness_instance_check', { commandId: randomUUID(),
      instanceId: profile.instanceId, expectedRevision: profile.revision, target: profile.target }, reader.token)
    expect(denied.isError).toBe(true)
    expect(JSON.stringify(denied.content)).toContain('ACCESS_DENIED')
    await fixture.provider.releaseModels()
    modelsBlocked = false
    const updated = await waitForInstallationUpdate(() => profiles(fixture, reader.token), values =>
      values.length === before.length && values.every(value => value.qualification === 'qualified'
        && value.target.installationFingerprint !== oldFingerprint), 'qualified updated installation in MCP')
    for (const value of updated) {
      const previous = before.find(profile => profile.instanceId === value.instanceId)!
      expect(value.instanceRevision).toBe(previous.instanceRevision)
      expect(value.revision).toBe(previous.revision + 1)
      expect(value.configuration).toEqual(previous.configuration)
    }
    const evidence = await latestEvidence(fixture)
    expect(evidence).toHaveLength(updated.length)
    expect(evidence.every(proof => proof.qualified
      && proof.target.installationFingerprint === updated[0]!.target.installationFingerprint)).toBe(true)
    const history = await fixture.db.pool.query<{ record: unknown }>(`select record
      from harness_instance_profile_evidence where instance_revision=1 order by instance_id`)
    expect(history.rows.map(row => HostHarnessProfileEvidenceSchema.parse(row.record)))
      .toEqual(oldProofs)

    const next = (await startWhenReady(fixture))!
    const pins = await fixture.db.pool.query<{ run_id: string; record: { payload: { installationFingerprint: string } } }>(
      'select run_id,record from run_node_placements where run_id=any($1::text[])', [[oldRun.run.id, next.run.id]])
    expect(pins.rows.filter(row => row.run_id === oldRun.run.id)).toHaveLength(fixture.version.definition.nodes.length)
    expect(pins.rows.filter(row => row.run_id === next.run.id)).toHaveLength(fixture.version.definition.nodes.length)
    expect(pins.rows.filter(row => row.run_id === oldRun.run.id)
      .every(row => row.record.payload.installationFingerprint === oldFingerprint)).toBe(true)
    expect(pins.rows.filter(row => row.run_id === next.run.id)
      .every(row => row.record.payload.installationFingerprint === updated[0]!.target.installationFingerprint)).toBe(true)
    await fixture.provider.releaseWorkflowTurns()
    turnsBlocked = false
    await waitForInstallationUpdate(() => fixture.provider.calls(), calls => calls.some(call => {
      const completed = call.workflowCompleted as typeof turn | undefined
      return completed?.pid === turn.pid && completed.sessionId === turn.sessionId && completed.turnId === turn.turnId
    }), 'completion from the original pinned native process')
    const details = await waitForInstallationUpdate(async () => {
      await fixture.reconcile()
      return fixture.details(oldRun.run.id)
    }, value => value.run.executionState === 'completed', 'completion of the Run started before the update')
    expect(details.run.workflowVersionId).toBe(fixture.version.id)
    expect(details.run.outcome).toBe('succeeded')
    const updatedRun = await waitForInstallationUpdate(async () => {
      await fixture.reconcile()
      return fixture.details(next.run.id)
    }, value => value.run.executionState === 'completed', 'completion of the Run on the updated installation')
    expect(updatedRun.run.outcome).toBe('succeeded')
  } finally {
    if (modelsBlocked) await fixture.provider.releaseModels()
    if (turnsBlocked) await fixture.provider.releaseWorkflowTurns()
    await fixture.close()
  }
}

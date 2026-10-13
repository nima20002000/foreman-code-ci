import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { randomUUID } from 'node:crypto'
import { expect } from 'vitest'
import { HostHarnessOverrideListSchema, HostHarnessProfileEvidenceSchema } from '@foreman-code/contracts/harness-registry'
import { remoteReviewProduction, waitForRemoteReview } from './remoteReviewProduction.js'
import { AcceptedNodePlacementSchema } from '@foreman-code/contracts/node-placement'
import { expectMcpAccessDenied } from './deniedMcpTool.js'
import { measureIntegrationPhase } from './integrationPhase.js'

type Fixture = Awaited<ReturnType<typeof remoteReviewProduction>>

export async function installationUpdateFixture(options: Parameters<typeof remoteReviewProduction>[0] = {}) {
  const fixture = await measureIntegrationPhase('installation update fixture', () => remoteReviewProduction({
    ...options, installationRefreshIntervalMs: options.installationRefreshIntervalMs ?? 500,
    parallelSetup: true, parallelProfileChecks: true, includeNodeRuntimePayload: false,
  }))
  return {
    ...fixture,
    close: () => measureIntegrationPhase('installation update cleanup', fixture.close),
  }
}

export async function waitForInstallationUpdate<T>(
  read: () => Promise<T>, accept: (value: T) => boolean, description: string,
): Promise<T> {
  return measureIntegrationPhase(description, () => waitForRemoteReview(read, accept, description))
}

export async function profiles(fixture: Fixture, token = fixture.writer.token) {
  const result = await fixture.call('harness_instances_list', { hostRef: fixture.hostRef,
    applicationInstallationId: fixture.profiles[0]!.target.applicationInstallationId }, token)
  expect(result.isError).not.toBe(true)
  return HostHarnessOverrideListSchema.parse(decodeMcpToolResult(result)).overrides
}

export async function latestEvidence(fixture: Fixture) {
  const result = await fixture.db.pool.query<{ record: unknown }>(`select distinct on(instance_id) record
    from harness_instance_profile_evidence order by instance_id,instance_revision desc,created_at desc,check_id desc`)
  return result.rows.map(row => HostHarnessProfileEvidenceSchema.parse(row.record))
}

export async function startWhenReady(fixture: Fixture) {
  return waitForInstallationUpdate(async () => {
    try {
      return await fixture.start()
    } catch (error) {
      if (error instanceof Error && error.message.includes('HARNESS_PROFILE_CHECK_PENDING')) return undefined
      throw error
    }
  }, result => result !== undefined, 'Start after installation qualification')
}

export async function pinnedPlacements(fixture: Fixture, runId: string) {
  const rows = await fixture.db.pool.query<{ record: unknown }>(
    'select record from run_node_placements where run_id=$1 order by node_id', [runId])
  return rows.rows.map(row => AcceptedNodePlacementSchema.parse(row.record))
}

export async function profileReader(fixture: Fixture) {
  const reader = await fixture.access.issue({ name: 'Update readback reader', audience: 'operator',
    expiresAt: new Date(Date.now() + 600_000), grants: [{ actions: ['harnesses:read'], scope: {} }] })
  const profile = (await profiles(fixture, reader.token))[0]!
  await expectMcpAccessDenied(fixture.call('harness_instance_check', { commandId: randomUUID(),
    instanceId: profile.instanceId, expectedRevision: profile.revision, target: profile.target }, reader.token))
  await expectMcpAccessDenied(fixture.call('run_start', { commandId: randomUUID(),
    workspaceId: fixture.version.workspaceId, workflowId: fixture.version.workflowId,
    workflowVersionId: fixture.version.id, executionSemanticsVersion: 3,
    expectedWorkflowRevision: fixture.version.version, expectedLocationRevision: 1,
    expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds, input: {},
  }, reader.token))
  return reader.token
}

export async function runningTurn(fixture: Fixture) {
  const calls = await waitForInstallationUpdate(() => fixture.provider.calls(), values =>
    values.some(call => call.workflowTurn !== undefined), 'the resident native turn')
  return calls.find(call => call.workflowTurn !== undefined)!.workflowTurn as {
    pid: number; sessionId: string; turnId: string
  }
}

export async function completedRun(fixture: Fixture, runId: string) {
  const details = await completedRuns(fixture, [runId])
  return details[0]!
}

export async function completedRuns(fixture: Fixture, runIds: string[]) {
  const details = await waitForInstallationUpdate(async () => {
    await fixture.reconcile()
    const reads = await Promise.allSettled(runIds.map(runId => fixture.details(runId)))
    const errors = reads.flatMap(result => result.status === 'rejected' ? [result.reason] : [])
    if (errors.length) throw new AggregateError(errors, 'Resident Run readback failed.')
    return reads.flatMap(result => result.status === 'fulfilled' ? [result.value] : [])
  }, values => values.every(value => value.run.executionState === 'completed'), 'resident Runs completion')
  for (const value of details) {
    expect(value.run.outcome, JSON.stringify({
      run: value.run.result,
      executions: value.executions.map(item => [item.id, item.result]),
    })).toBe('succeeded')
  }
  return details
}


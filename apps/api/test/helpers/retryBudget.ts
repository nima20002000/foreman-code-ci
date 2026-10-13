import { afterEach, describe, expect, vi } from 'vitest'
import { RunStartV3ResultSchema, type RunStartV3Input } from '@foreman-code/contracts/wave25'
import { postgresEnabled } from './wave25Agent3.js'
import {
  assertOriginalFailure, executionRows, fullRunInput, readback, recoveryFixture, toolValue,
  type Form, type RecoveryFixture,
} from './eng06DRecovery.js'
import { measureIntegrationPhase } from './integrationPhase.js'

export const attempts = (rows: Awaited<ReturnType<typeof executionRows>>) => rows.map((row) => row.execution.attempt).sort((a, b) => a - b)
export async function occurrences(f: RecoveryFixture, runId = f.base.f.run.id) {
  return (await f.base.db.pool.query<{ occurrence_index: number }>(
    'select occurrence_index from run_repeat_occurrences where run_id=$1 order by occurrence_index', [runId])).rows
}
export function sameSlot(rows: Awaited<ReturnType<typeof executionRows>>) {
  expect(new Set(rows.map((row) => row.slot_id)).size).toBe(1)
  expect(new Set(rows.map((row) => row.input_json)).size).toBe(1)
  expect(new Set(rows.map((row) => row.input_digest)).size).toBe(1)
  expect(new Set(rows.map((row) => row.execution.id)).size).toBe(rows.length)
  for (const row of rows) {
    expect(row.execution.sessionContinuation).toBeUndefined()
    expect(row.execution.agentConfigurationVersionId).toBe(rows[0]!.execution.agentConfigurationVersionId)
    expect(row.execution.input).toEqual(rows[0]!.execution.input)
  }
}

export function describeRetryBudget(label: string, cases: () => void) {
  describe.skipIf(!postgresEnabled)(label, () => {
    afterEach(() => vi.restoreAllMocks())
    cases()
  })
}

async function startRetryRun(f: RecoveryFixture, via: 'http' | 'mcp', input: RunStartV3Input) {
  if (via === 'mcp') {
    return RunStartV3ResultSchema.parse(toolValue(await f.transport.client.callTool({
      name: 'run_start', arguments: input,
    })))
  }
  const response = await f.transport.app.inject({
    method: 'POST',
    url: `/api/management/workspaces/${input.workspaceId}/workflows/${input.workflowId}/runs`,
    headers: { authorization: `Bearer ${f.base.writer.token}` },
    payload: input,
  })
  expect(response.statusCode, response.body).toBeGreaterThanOrEqual(200)
  expect(response.statusCode, response.body).toBeLessThan(300)
  return RunStartV3ResultSchema.parse(response.json())
}

export async function assertFullRunRetryBudget(form: Form, via: 'http' | 'mcp') {
  const f = await recoveryFixture(form, () => 'retryable_failure')
  try {
    f.launch()
    await f.settled()
    const old = await measureIntegrationPhase('retry budget original readback', () => readback(f))
    const oldRows = await executionRows(f)
    await f.restart()
    const input = await measureIntegrationPhase('retry budget location setup', () => fullRunInput(f))
    const accepted = await measureIntegrationPhase('retry budget full Run Start', () => startRetryRun(f, via, input))
    const replayed = await measureIntegrationPhase('retry budget full Run Start replay', () => startRetryRun(f, via, input))
    expect(accepted.accepted).toBe(true)
    expect(accepted.replayed).toBe(false)
    expect(accepted.run.id).not.toBe(old.record.run.id)
    expect(replayed.replayed).toBe(true)
    expect(replayed.run.id).toBe(accepted.run.id)
    expect(accepted.run.input).toEqual(old.record.run.input)
    expect(accepted.run.workflowVersionId).toBe(old.record.run.workflowVersionId)
    expect(accepted.run.agentConfigurationVersionIds).toEqual(old.record.run.agentConfigurationVersionIds)
    await f.settled(accepted.run.id)
    const fresh = await measureIntegrationPhase('retry budget fresh Run readback', () => readback(f, accepted.run.id))
    const newRows = await executionRows(f, accepted.run.id)
    expect(fresh.record.run.outcome).toBe('failed')
    const diagnostics = { rows: newRows.map((row) => row.execution), diagnostics: f.diagnostics() }
    expect(attempts(newRows), JSON.stringify(diagnostics)).toEqual([1, 2])
    sameSlot(newRows)
    for (const row of newRows) await assertOriginalFailure(f, row.execution.id, true)
    expect(newRows.every((row) => !oldRows.some((oldRow) => oldRow.execution.id === row.execution.id))).toBe(true)
    expect(await readback(f)).toEqual(old)
    expect(f.provider.counts.starts).toBe(4)
    expect(await occurrences(f, accepted.run.id)).toHaveLength(form === 'repeat' ? 1 : 0)
    if (form === 'repeat') {
      expect(newRows[0]!.input.occurrence!.identity.occurrenceId)
        .not.toBe(oldRows[0]!.input.occurrence!.identity.occurrenceId)
    }
    expect((await f.base.db.pool.query('select id from runs where workflow_id=$1', [input.workflowId])).rows)
      .toHaveLength(2)
    expect(f.shutdownErrors).toEqual([])
  } finally {
    await f.close()
  }
}

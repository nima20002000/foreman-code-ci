import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { CiRunRecordSchema, type CiRunRecord } from '@foreman-code/contracts'
import { ciIntegrationSelectionMigration } from '../src/infrastructure/ciIntegrationSelectionMigration.js'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { readQueuedCiRuns } from '../src/modules/ci-host/queuedRuns.js'
import { currentDatabase } from './helpers/eng04CurrentDatabase.js'

it.each(['running', 'passed'] as const)('restarts all legacy partitions with one input when a sibling is %s', async state => {
  const db = await currentDatabase({ beforeMigration: ciIntegrationSelectionMigration.version })
  try {
    const workspaceId = randomUUID()
    await db.pool.query('insert into workspaces(id,record) values($1,$2)', [workspaceId,
      JSON.stringify({ id: workspaceId, name: 'CI migration fixture' })])
    const groupId = randomUUID()
    const original = [state, 'queued'].map((partState, index) => CiRunRecordSchema.parse({
      id: randomUUID(), workspaceId, groupId, suite: 'integration', commit: 'a'.repeat(40), repository: 'example/project',
      scope: 'affected', deriveFiles: true, defaultBranch: 'main', files: [], state: partState,
      partition: { index, count: 2 }, part: null, computer: null, step: null, exitCode: partState === 'passed' ? 0 : null,
      message: null, queuedAt: new Date().toISOString(), startedAt: index ? null : new Date().toISOString(),
      finishedAt: partState === 'passed' ? new Date().toISOString() : null,
      initiator: { principalId: 'fixture-caller', executionId: null },
    }))
    const durations = { 'apps/api/test/a.integration.test.ts': 200, 'apps/api/test/b.integration.test.ts': 100 }
    for (const run of original) await db.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,record,durations)
      values($1,$2,$3,$4,$5,$6)`, [run.id, workspaceId, groupId, run.state, JSON.stringify(run), JSON.stringify(durations)])
    await applyApplicationMigrations(db.pool)
    const rows = (await db.pool.query<{ record: CiRunRecord }>('select record from ci_runs')).rows
      .map(row => CiRunRecordSchema.parse(row.record))
    const replacements = rows.filter(run => run.groupId !== groupId)
    expect(replacements).toHaveLength(2)
    expect(new Set(replacements.map(run => run.groupId)).size).toBe(1)
    expect(replacements.map(run => run.partition!.index).sort()).toEqual([0, 1])
    for (const run of replacements) expect(run).toMatchObject({ state: 'queued', startedAt: null, finishedAt: null,
      computer: null, deriveFiles: true })
    for (const old of original) expect(rows.find(run => run.id === old.id)).toMatchObject({ ...old,
      supersededBy: replacements.find(run => run.partition!.index === old.partition!.index)!.id })
    const queued = await readQueuedCiRuns(db.pool)
    expect(queued.parsed.map(run => run.id).sort()).toEqual(replacements.map(run => run.id).sort())
    expect(queued.coverage.size).toBe(1)
    expect(queued.coverage.get(replacements[0]!.groupId)).toMatchObject({ changedFiles: [], reason: expect.any(String) })
    for (const run of replacements) expect(queued.durations.get(run.id)).toEqual(durations)
  } finally { await db.close() }
})

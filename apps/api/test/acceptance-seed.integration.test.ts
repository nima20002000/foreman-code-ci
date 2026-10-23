import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, AgentConfigurationVersionSchema, AgentSchema } from '@foreman-code/contracts'
import { WorkflowDefinitionCurrentSchema, WorkflowVersionCurrentSchema, ExecutableWorkflowCurrentSchema, canonicalGraphJson } from '@foreman-code/contracts/current'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import { readImmutableWorkflowVersion } from '../src/modules/workflows/immutableRead.js'

import { migratedDatabase } from './helpers/migratedDatabase.js'
import { postgresEnabled } from './helpers/database.js'

let db: Awaited<ReturnType<typeof migratedDatabase>>
beforeEach(async () => { db = await migratedDatabase() })
afterEach(async () => { await db?.close() })

describe.skipIf(!postgresEnabled)('clean-start seed uses current immutable read contracts', () => {
  it('seeds an executable ordinary V3 graph with explicit physical and JSON pins and a verifiable hash', async () => {
    await ensureAcceptanceSeed(db.pool)
    const workflow = WorkflowDefinitionCurrentSchema.parse((await db.pool.query('select record from workflows where id=$1', ['workflow-content-pipeline'])).rows[0].record)
    const row = (await db.pool.query('select * from workflow_versions where workflow_id=$1', [workflow.id])).rows[0]
    const version = WorkflowVersionCurrentSchema.parse(row.record)
    const configurations = (await db.pool.query('select record from agent_configuration_versions order by agent_id desc')).rows
      .map(item => AgentConfigurationVersionSchema.parse(item.record))
    const agents = (await db.pool.query('select record from agents order by id desc')).rows.map(item => AgentSchema.parse(item.record))

    expect(workflow).toEqual(version.definition)
    expect(workflow.executionSemanticsVersion).toBe(3)
    expect(version.executionSemanticsVersion).toBe(3)
    expect(workflow).not.toHaveProperty('repeat')
    expect(workflow.edges.map((edge) => edge.kind)).toEqual(['execution', 'execution'])
    expect(workflow.edges.every((edge) => !Object.hasOwn(edge, 'route'))).toBe(true)
    expect(workflow.entryNodeId).toBe('node-researcher')
    expect(configurations.map((configuration) => configuration.productRole)).toEqual(['coder', 'coder', 'coder'])
    expect(agents.map((agent) => agent.productRole)).toEqual(['coder', 'coder', 'coder'])
    expect(configurations.map((configuration) => configuration.harness.harness)).toEqual(['codex', 'codex', 'codex'])
    expect(configurations.find(configuration => configuration.agentId === 'agent-developer')!.harness.model).toBe(DEFAULT_HARNESS_DEFAULTS.codex.model)
    expect(ExecutableWorkflowCurrentSchema.parse({ version, configurations })).toEqual({ version, configurations })
    expect(row.execution_semantics_version).toBe(3)
    expect(version.contentHash).toBe(`sha256:${createHash('sha256').update(canonicalGraphJson({
      definition: workflow, configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId,
    })).digest('hex')}`)
    expect(readImmutableWorkflowVersion(row)).toEqual(version)
    expect(db.pool.idleCount).toBe(db.pool.totalCount)
  })

  it('never repairs or converts a retired seed record during current immutable read', async () => {
    await ensureAcceptanceSeed(db.pool)
    const row = (await db.pool.query('select * from workflow_versions where workflow_id=$1', ['workflow-content-pipeline'])).rows[0]
    const version = WorkflowVersionCurrentSchema.parse(row.record)
    for (const tag of [undefined, null, 1, 2, '3', 4]) {
      const bad = { ...version, executionSemanticsVersion: tag }
      const before = structuredClone(bad)
      expect(() => readImmutableWorkflowVersion({ ...row, record: bad })).toThrow()
      expect(bad).toEqual(before)
      expect(() => readImmutableWorkflowVersion({ ...row, record: { ...version,
        definition: { ...version.definition, executionSemanticsVersion: tag } } })).toThrow()
    }
    for (const execution_semantics_version of [1, 2, 4]) {
      expect(() => readImmutableWorkflowVersion({ ...row, execution_semantics_version })).toThrow('Only explicitly pinned current execution semantics 3')
    }
    expect(() => readImmutableWorkflowVersion({ ...row, record: { ...version, contentHash: `sha256:${'0'.repeat(64)}` } }))
      .toThrow('content hash does not match')
  })

  it('retains existing records and physical pins on repeated seeding', async () => {
    await ensureAcceptanceSeed(db.pool)
    const snapshot = async () => Promise.all(['workspaces', 'agents', 'agent_configuration_versions', 'workflows', 'workflow_versions']
      .map(async table => (await db.pool.query(`select * from ${table} order by id`)).rows))
    await db.pool.query("update workspaces set record=jsonb_set(record,'{name}',to_jsonb('User renamed workspace'::text)) where id='workspace-1'")
    const before = await snapshot()
    await ensureAcceptanceSeed(db.pool)
    expect(await snapshot()).toEqual(before)
    expect(before.map(rows => rows.length)).toEqual([1, 3, 3, 1, 1])
  })

  it('rolls back every seed record and releases the owned client when an insert fails', async () => {
    await db.pool.query(`create function reject_seed_version() returns trigger language plpgsql as $$
      begin raise exception 'seed insert rejected'; end $$;
      create trigger reject_seed_version before insert on workflow_versions
        for each row execute function reject_seed_version()`)
    await expect(ensureAcceptanceSeed(db.pool)).rejects.toThrow('seed insert rejected')
    for (const table of ['workspaces', 'agents', 'agent_configuration_versions', 'workflows', 'workflow_versions']) {
      expect((await db.pool.query(`select count(*)::int as count from ${table}`)).rows[0].count).toBe(0)
    }
    expect(db.pool.idleCount).toBe(db.pool.totalCount)
    await db.pool.query('drop trigger reject_seed_version on workflow_versions; drop function reject_seed_version()')
    await ensureAcceptanceSeed(db.pool)
    expect((await db.pool.query('select count(*)::int as count from workflow_versions')).rows[0].count).toBe(1)
  })
})

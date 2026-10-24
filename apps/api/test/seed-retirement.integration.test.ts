import { createHash } from 'node:crypto'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { DEFAULT_HARNESS_DEFAULTS, AgentConfigurationVersionSchema, AgentSchema } from '@foreman-code/contracts'
import { WorkflowDefinitionCurrentSchema, ExecutableWorkflowCurrentSchema, canonicalGraphJson } from '@foreman-code/contracts/current'
import { ensureAcceptanceSeed } from '../src/infrastructure/seed.js'
import { readImmutableWorkflowVersion } from '../src/modules/workflows/immutableRead.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { postgresEnabled } from './helpers/database.js'

describe.skipIf(!postgresEnabled)('clean-start seed uses current read contracts', () => {
  let db: Awaited<ReturnType<typeof migratedDatabase>>
  beforeEach(async () => { db = await migratedDatabase() })
  afterEach(async () => { await db?.close() })
  async function seeded() {
    await ensureAcceptanceSeed(db.pool)
    const row = (await db.pool.query('select * from workflow_versions where id=$1', ['workflow-content-pipeline-v1'])).rows[0]!
    const version = readImmutableWorkflowVersion(row)
    const workflow = WorkflowDefinitionCurrentSchema.parse((await db.pool.query('select record from workflows where id=$1', [version.workflowId])).rows[0]!.record)
    const configurations = (await db.pool.query('select record from agent_configuration_versions order by agent_id')).rows
      .map(({ record }) => AgentConfigurationVersionSchema.parse(record))
    const agents = (await db.pool.query('select record from agents order by id')).rows.map(({ record }) => AgentSchema.parse(record))
    return { row, version, workflow, configurations, agents }
  }
  it('seeds an executable ordinary graph with physical and JSON pins and a verifiable hash', async () => {
    const { row, version, workflow, configurations, agents } = await seeded()
    expect(workflow).toEqual(version.definition)
    expect(row.execution_semantics_version).toBe(3)
    expect(version.executionSemanticsVersion).toBe(3)
    expect(workflow).not.toHaveProperty('repeat')
    expect(workflow.edges.map(edge => edge.kind)).toEqual(['execution', 'execution'])
    expect(workflow.edges.every(edge => !Object.hasOwn(edge, 'route'))).toBe(true)
    expect(workflow.entryNodeId).toBe('node-researcher')
    expect(configurations.map(configuration => configuration.productRole)).toEqual(['coder', 'coder', 'coder'])
    expect(agents.map(agent => agent.productRole)).toEqual(['coder', 'coder', 'coder'])
    expect(configurations.map(configuration => configuration.harness.harness)).toEqual(['codex', 'codex', 'codex'])
    expect(configurations.find(configuration => configuration.agentId === 'agent-developer')!.harness.model).toBe(DEFAULT_HARNESS_DEFAULTS.codex.model)
    expect(ExecutableWorkflowCurrentSchema.parse({ version, configurations })).toEqual({ version, configurations })
    expect(version.contentHash).toBe(`sha256:${createHash('sha256').update(canonicalGraphJson({
      definition: workflow, configurations: version.agentConfigurationVersionIds, entryNodeId: version.entryNodeId,
    })).digest('hex')}`)
  })
  it('never repairs or converts a retired seed record during current immutable read', async () => {
    const { row, version } = await seeded()
    for (const tag of [undefined, null, 1, 2, '3', 4]) {
      const bad = { ...version, executionSemanticsVersion: tag }, before = structuredClone(bad)
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
  it('keeps insert-only repeatability without replacing existing records', async () => {
    await seeded()
    await db.pool.query(`update workspaces set record=record || $2::jsonb where id=$1`, ['workspace-1', JSON.stringify({ name: 'Owner edits' })])
    const before = await seeded()
    expect(await seeded()).toEqual(before)
    expect((await db.pool.query('select record from workspaces where id=$1', ['workspace-1'])).rows[0]!.record.name).toBe('Owner edits')
    expect(before.configurations).toHaveLength(3)
    expect(before.agents).toHaveLength(3)
  })
  it('rolls back all seed writes and releases the client when the version insert fails', async () => {
    await db.pool.query("alter table workflow_versions add constraint seed_insert_fault check (id <> 'workflow-content-pipeline-v1')")
    await expect(ensureAcceptanceSeed(db.pool)).rejects.toMatchObject({ code: '23514' })
    for (const table of ['workspaces', 'agents', 'agent_configuration_versions', 'workflows', 'workflow_versions']) {
      expect((await db.pool.query(`select count(*)::int as count from ${table}`)).rows[0]!.count).toBe(0)
    }
    expect(db.pool.idleCount).toBe(db.pool.totalCount)
  })
})

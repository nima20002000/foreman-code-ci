import { createHash, randomUUID } from 'node:crypto'
import { afterEach, describe, expect, it } from 'vitest'
import { MAX_AGENT_INSTRUCTIONS_BYTES, type ResolvedSkill } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/current'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { agentInstructionBundle } from '../src/modules/skills/instructions.js'
import { WorkflowManagementService } from '../src/modules/workflows/management.js'
import { PostgresWorkflowRepository } from '../src/modules/workflows/postgres.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { seedWorkflowFixture } from './helpers/workflowDatabase.js'

const hash = (text: string) => `sha256:${createHash('sha256').update(text).digest('hex')}`
const databases: Awaited<ReturnType<typeof migratedDatabase>>[] = []
afterEach(async () => { await Promise.all(databases.splice(0).map(database => database.close())) })

async function fixture(system = '') {
  const database = await migratedDatabase()
  databases.push(database)
  const { pool } = database
  const workflow = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
  const configuration = workflow.configurations[0]!
  configuration.instructionDelivery = 'native-v1'
  if (system) configuration.prompt.system = system
  const skill = { skillId: 'review-guide', version: '1', name: 'Review guide', instructions: 'Check the result.',
    contentHash: hash('Check the result.') }
  const saved = await seedWorkflowFixture(pool, database.directory, workflow, { run: false, skills: [skill] })
  const node = saved.version.definition.nodes[0]!
  node.skills = { add: [{ skillId: skill.skillId, version: skill.version }] }
  const principal = (await new PostgresAccessService(pool).issue({ name: 'Skill author', audience: 'operator',
    expiresAt: new Date(Date.now() + 60_000), grants: [{ actions: ['workflows:read', 'workflows:update', 'graph:read',
      'graph:edit', 'graph:save', 'agents:read', 'workspace_locations:read', 'skills:read'], scope: {} }] })).principal
  const head = (await pool.query('select revision::int as revision from workflows where id=$1', [saved.scope.workflowId])).rows[0]!
  const authoring = new WorkflowManagementService(pool, new PostgresCommandCoordinator(pool))
  const save = async () => (await authoring.current.save(principal, 'http', {
    commandId: randomUUID(), workspaceId: saved.scope.workspaceId, workflowId: saved.scope.workflowId,
    expectedRevision: head.revision, expectedWorkflowVersionId: saved.version.id, executionSemanticsVersion: 3,
    expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds, graph: saved.version.definition,
  })).value
  return { configuration, node, skill, pool, save, original: saved.version,
    archive: () => pool.query('update workspace_skills set archived_at=now() where workspace_id=$1 and skill_id=$2',
      [saved.scope.workspaceId, skill.skillId]) }
}

describe('node skill publication', () => {
  it('saves added instructions with their versions and observes them after archival without catalog reads', async () => {
    const f = await fixture()
    const saved = await f.save()
    const repository = new PostgresWorkflowRepository(f.pool)
    const version = await repository.getSavedVersion(saved.version.id)
    const snapshots = (version as typeof version & { nodeSkillSnapshots?: Record<string, ResolvedSkill[]> })
      ?.nodeSkillSnapshots?.[f.node.id]
    expect(snapshots).toMatchObject([{ skillId: f.skill.skillId, version: f.skill.version,
      instructions: f.skill.instructions, contentHash: f.skill.contentHash }])
    await f.archive()
    for (let observation = 0; observation < 2; observation++) {
      const effective = await repository.resolveNodeSkills(f.configuration, f.node.skills!, snapshots)
      expect(agentInstructionBundle(effective)?.text).toContain(f.skill.instructions)
      expect(effective.assignedSkills).toEqual(f.node.skills!.add)
    }
  })

  it('rejects newly added archived versions before publication', async () => {
    const f = await fixture()
    await f.archive()
    await expect(f.save()).rejects.toMatchObject({ code: 'SKILL_ARCHIVED' })
  })

  it('rejects combined instructions above 512 KiB before publishing a version', async () => {
    const f = await fixture('x'.repeat(MAX_AGENT_INSTRUCTIONS_BYTES - 10))
    await expect(f.save()).rejects.toMatchObject({ code: 'AGENT_INSTRUCTIONS_TOO_LARGE' })
    const versions = await f.pool.query('select id from workflow_versions where workflow_id=$1', [f.original.workflowId])
    expect(versions.rows).toEqual([{ id: f.original.id }])
  })

  it('accepts the complete effective instructions at the byte limit', async () => {
    const skillText = '# Skill: Review guide (review-guide@1)\n\nCheck the result.'
    const f = await fixture('x'.repeat(MAX_AGENT_INSTRUCTIONS_BYTES - Buffer.byteLength(skillText) - 2))
    await expect(f.save()).resolves.toHaveProperty('version.id')
  })
})

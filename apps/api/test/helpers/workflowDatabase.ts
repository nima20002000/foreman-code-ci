import { agentWorkflowVersion } from './agentWorkflowFixture.js'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { AgentSchema, HarnessExecutionSchema, type HarnessExecution, type ResolvedSkill } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture, AcceptedRepeatStartV1Schema, WorkflowRunCurrentSchema } from '@foreman-code/contracts/current'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { WorkflowManagementService } from '../../src/modules/workflows/management.js'
import { withExclusiveGraphConnection } from '../../src/modules/run-graph/connection.js'
import { insertRepeatRun } from '../../src/modules/runs/repeatStartAdmission.js'
import { repeatStartPublication } from '../../src/modules/run-graph/repeatStartPublication.js'
import type { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import { LOCAL_RUNNER_ID } from '../../src/modules/workspaces/location.js'

export type CurrentWorkflowFixture = ReturnType<typeof makeCurrentWorkflowFixture>

export async function seedWorkflowFixture(pool: pg.Pool, directory: string, fixture = makeCurrentWorkflowFixture(randomUUID()), options: { run?: boolean; skills?: ResolvedSkill[] } = {}) {
  const location = { runnerId: LOCAL_RUNNER_ID, rootPath: directory, locationRevision: 1, identityHash: 'sha256:' + '1'.repeat(64) }
  fixture.run = WorkflowRunCurrentSchema.parse({ ...fixture.run, executionLocation: location })
  await pool.query(`insert into workspaces(id,record,execution_location,execution_location_identity,location_revision)
    values($1,$2::jsonb,$3::jsonb,$4::jsonb,1)`, [fixture.scope.workspaceId, JSON.stringify({ id: fixture.scope.workspaceId, name: 'Synthetic workflow fixture' }),
  JSON.stringify({ runnerId: location.runnerId, rootPath: location.rootPath }), JSON.stringify({ synthetic: true })])
  for (const skill of options.skills ?? []) {
    const record = { ...skill, workspaceId: fixture.scope.workspaceId, name: skill.name ?? skill.skillId,
      createdAt: fixture.createdAt }
    await pool.query(`insert into workspace_skill_versions(workspace_id,skill_id,version,sequence,record)
      values($1,$2,$3,1,$4::jsonb)`, [fixture.scope.workspaceId, skill.skillId, skill.version, JSON.stringify(record)])
    await pool.query(`insert into workspace_skills(workspace_id,skill_id,head_version,revision,version_count)
      values($1,$2,$3,1,1)`, [fixture.scope.workspaceId, skill.skillId, skill.version])
  }
  for (const config of fixture.configurations) {
    const agent = AgentSchema.parse({ id: config.agentId, name: 'Synthetic Worker', productRole: config.productRole,
      harness: config.harness.harness, model: config.harness.model, effort: 'low', fastMode: false,
      harnessConfiguration: config.harness, prompt: config.prompt, assignedSkills: config.assignedSkills, configurationVersionId: config.id })
    await pool.query('insert into agents(id,workspace_id,current_configuration_version_id,record) values($1,$2,null,$3::jsonb)',
      [config.agentId, fixture.scope.workspaceId, JSON.stringify(agent)])
    await pool.query('insert into agent_configuration_versions(id,workspace_id,agent_id,version,record) values($1,$2,$3,1,$4::jsonb)',
      [config.id, fixture.scope.workspaceId, config.agentId, JSON.stringify(config)])
    await pool.query('update agents set current_configuration_version_id=$2 where id=$1', [config.agentId, config.id])
  }
  const access = new PostgresAccessService(pool)
  const writer = await access.issue({ name: 'Current fixture author', audience: 'operator',
    expiresAt: new Date(Date.now() + 300000), grants: [{ actions: [
      'workflows:create', 'workflows:read', 'workflows:update', 'graph:read', 'graph:edit', 'graph:save',
      'agents:read', 'workspace_locations:read', 'skills:read', 'harnesses:update',
    ], scope: { workspaceIds: [fixture.scope.workspaceId] } }] })
  const workflows = new WorkflowManagementService(pool, new PostgresCommandCoordinator(pool))
  const created = (await workflows.create(writer.principal, 'http', { workspaceId: fixture.scope.workspaceId,
    commandId: randomUUID(), name: fixture.version.definition.name })).value
  // This is the same typed writer used by /definition. It assigns saved IDs and
  // immutable version facts; no direct current-version update is permitted.
  const saved = (await workflows.current.save(writer.principal, 'http', JSON.parse(JSON.stringify({
    workspaceId: fixture.scope.workspaceId, workflowId: created.workflow.id,
    commandId: randomUUID(), executionSemanticsVersion: 3, expectedRevision: created.revision,
    expectedWorkflowVersionId: null,
    expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
    graph: { ...fixture.version.definition, id: created.workflow.id, version: created.workflow.version,
      createdAt: created.workflow.createdAt, updatedAt: created.workflow.updatedAt },
  })))).value
  fixture.version = agentWorkflowVersion(saved.version)
  fixture.scope = { ...fixture.scope, workflowId: saved.workflowId, workflowVersionId: saved.version.id }
  fixture.run = WorkflowRunCurrentSchema.parse({ ...fixture.run, workflowId: saved.workflowId,
    workflowVersionId: saved.version.id, agentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
    approval: saved.version.approval, authorizationPrincipalId: writer.principal.id })
  if (options.run !== false) {
    const authorizationPrincipalId = writer.principal.id
    fixture.run = WorkflowRunCurrentSchema.parse({ ...fixture.run, authorizationPrincipalId })
    const accepted = AcceptedRepeatStartV1Schema.parse({ run: fixture.run, snapshot: {
      request: { workspaceId: fixture.scope.workspaceId, workflowId: fixture.scope.workflowId,
        workflowVersionId: fixture.version.id, executionSemanticsVersion: 3, commandId: randomUUID(),
        expectedWorkflowRevision: saved.revision, expectedAgentConfigurationVersionIds: fixture.version.agentConfigurationVersionIds,
        expectedLocationRevision: location.locationRevision, input: fixture.run.input },
      authorizationPrincipalId, executable: { version: fixture.version, configurations: fixture.configurations },
      workflow: { id: fixture.scope.workflowId, workspaceId: fixture.scope.workspaceId, revision: saved.revision,
        currentVersionId: fixture.version.id, archived: false, definition: fixture.version.definition },
      workspace: { id: fixture.scope.workspaceId, archived: false, location }, draft: null,
    } })
    await withExclusiveGraphConnection(pool, (connection) => connection.transaction((sql) =>
      insertRepeatRun(sql, accepted, repeatStartPublication)))
  }
  return fixture
}

export function candidateFor(fixture: CurrentWorkflowFixture, nodeId = fixture.version.entryNodeId): HarnessExecution {
  const identity = fixture.identities.find((item) => item.workflowNodeId === nodeId)
  if (!identity) throw new Error('Unknown synthetic node')
  return HarnessExecutionSchema.parse({ id: identity.executionId, runId: fixture.run.id, workflowNodeId: nodeId,
    agentId: identity.agentId, agentConfigurationVersionId: identity.agentConfigurationVersionId,
    attempt: 1, input: {}, state: 'queued', createdAt: fixture.createdAt })
}

export async function graphHead(pool: pg.Pool, runId: string): Promise<string> {
  return (await pool.query<{ head: string }>('select head_sequence::text as head from run_graph_heads where run_id=$1', [runId])).rows[0]!.head
}

/** Consume the current paged repository reader without truncating test evidence. */
export async function readCurrentExecutions(runs: Pick<PostgresRunRepository, 'executionPages'>, runId: string): Promise<HarnessExecution[]> {
  const executions: HarnessExecution[] = []
  for await (const page of runs.executionPages(runId)) executions.push(...page)
  return executions
}

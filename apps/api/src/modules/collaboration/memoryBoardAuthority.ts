import {
  AgentConfigurationVersionSchema, AgentIdentitySchema, HarnessExecutionSchema,
  effectiveGraphqlTools, memoryBoardTools, sameAgentNode, sameExecution,
  type AgentSubject, type LogicalWorkRef, type MemoryBoardScope,
} from '@foreman-code/contracts'
import { WorkflowVersionV3Schema } from '@foreman-code/contracts/wave25'
import type { GraphTransactionSql } from '../run-graph/connection.js'
import { DomainError } from '../errors.js'
import { WORKER_BINDING_ELIGIBLE } from '../access/workerEligibility.js'
import type { MemoryBoardAuthority, ResolvedWork, SubjectAccess } from '../memory-boards/types.js'

function unavailable(message: string): never {
  throw new DomainError('NOT_FOUND', message, 404)
}

export async function memoryExecution(tx: GraphTransactionSql, executionId: string) {
  const row = (await tx.query<{
    execution: unknown; version: unknown; configuration: unknown; slot_id: string;
    work_activation_id: string | null; accepted: boolean; previous_execution_id: string | null;
  }>(`select e.record as execution,v.record as version,c.record as configuration,
      x.slot_id,x.work_activation_id,e.accepted,x.previous_execution_id
    from harness_executions e join runs r on r.id=e.run_id
    join workflow_versions v on v.id=r.workflow_version_id
    join run_repeat_executions x on x.execution_id=e.id and x.run_id=r.id
    join agent_configuration_versions c on c.id=e.record->>'agentConfigurationVersionId'
      and c.agent_id=e.agent_id and c.workspace_id=r.workspace_id
    where e.id=$1`, [executionId])).rows[0]
  if (!row) return unavailable('The saved workflow execution is unavailable.')
  const execution = HarnessExecutionSchema.parse(row.execution)
  const version = WorkflowVersionV3Schema.parse(row.version)
  const configuration = AgentConfigurationVersionSchema.parse(row.configuration)
  const node = version.definition.nodes.find(candidate => candidate.id === execution.workflowNodeId)
  if (!node || node.kind === 'job' || node.agentId !== execution.agentId
    || version.agentConfigurationVersionIds[execution.agentId] !== configuration.id) {
    throw new DomainError('EXECUTION_IDENTITY_CONFLICT', 'The execution does not match its saved Agent.', 409)
  }
  const agent = AgentIdentitySchema.parse({ workspaceId: version.workspaceId, workflowId: version.workflowId,
    workflowNodeId: node.id, agentId: execution.agentId, productRole: configuration.productRole,
    displayName: node.name ?? node.label ?? node.id, configurationVersionId: configuration.id })
  const reference = { runId: execution.runId, workflowVersionId: version.id, executionId: execution.id,
    attempt: execution.attempt, ...(row.work_activation_id ? { activationId: row.work_activation_id } : {}) }
  const work: LogicalWorkRef = row.work_activation_id
    ? { kind: 'activation', runId: execution.runId, workflowVersionId: version.id, activationId: row.work_activation_id }
    : { kind: 'slot', runId: execution.runId, workflowVersionId: version.id, slotId: row.slot_id }
  const subject: AgentSubject = { kind: 'execution', agent, execution: reference }
  return { execution, version, configuration, node, subject, work, accepted: row.accepted,
    previousExecutionId: row.previous_execution_id }
}

async function subjectAccess(tx: GraphTransactionSql, supplied: AgentSubject): Promise<SubjectAccess> {
  if (supplied.kind !== 'execution') {
    throw new DomainError('ACCESS_DENIED', 'Memory tools require a bound workflow execution.', 403)
  }
  const saved = await memoryExecution(tx, supplied.execution.executionId)
  if (!sameAgentNode(saved.subject.agent, supplied.agent)
    || saved.subject.agent.configurationVersionId !== supplied.agent.configurationVersionId
    || saved.subject.agent.productRole !== supplied.agent.productRole
    || !sameExecution(saved.subject.execution, supplied.execution)) {
    throw new DomainError('ACCESS_DENIED', 'The memory subject does not match its saved execution.', 403)
  }
  const readOnly = saved.configuration.harness.harness === 'opencode' || saved.configuration.harness.sandbox === 'read-only'
  const tools = effectiveGraphqlTools(saved.subject.agent.productRole, saved.configuration.graphqlTools,
    saved.node.graphqlTools, Boolean(saved.node.interval), memoryBoardTools('write'))
    .filter(tool => !readOnly || !memoryBoardTools('write').some(name => name === tool) || memoryBoardTools('read').some(name => name === tool))
  return { principalId: `execution:${saved.execution.id}`, subject: saved.subject, tools, readOnly,
    branchNodeIds: [saved.node.id] }
}

export async function resolveMemoryWork(tx: GraphTransactionSql, work: LogicalWorkRef): Promise<ResolvedWork> {
  const column = work.kind === 'activation' ? 'work_activation_id' : 'slot_id'
  const id = work.kind === 'activation' ? work.activationId : work.slotId
  const row = (await tx.query<{ execution_id: string }>(`select x.execution_id from run_repeat_executions x
    join runs r on r.id=x.run_id where x.run_id=$1 and r.workflow_version_id=$2 and x.${column}=$3
    order by x.technical_attempt desc limit 1`, [work.runId, work.workflowVersionId, id])).rows[0]
  if (!row) return unavailable('The selected logical work is unavailable.')
  const saved = await memoryExecution(tx, row.execution_id)
  const { execution, subject } = saved
  let state: ResolvedWork['state'] = 'running'
  let reason: string | null = null
  if (execution.state === 'queued') state = 'queued'
  else if (execution.result?.outcome === 'failed' || execution.result?.outcome === 'canceled') {
    state = execution.result.outcome
    reason = execution.result.error?.message ?? 'The execution was canceled.'
  } else if (execution.state === 'completed') state = saved.accepted ? 'accepted' : 'awaiting_acceptance'
  if (work.kind === 'activation') {
    const activation = (await tx.query<{ state: string }>(
      'select state from run_work_activations where run_id=$1 and activation_id=$2',
      [work.runId, work.activationId])).rows[0]
    if (activation?.state === 'waiting') state = 'waiting_children'
    if (activation?.state === 'needs_direction') { state = 'blocked'; reason = 'The work needs direction.' }
  }
  const { workspaceId, workflowId, workflowNodeId, agentId } = subject.agent
  return { node: { workspaceId, workflowId, workflowNodeId, agentId }, work, state,
    currentExecutionId: execution.id, reason }
}

async function assertScope(tx: GraphTransactionSql, scope: MemoryBoardScope): Promise<void> {
  const workspace = await tx.query('select id from workspaces where id=$1', [scope.workspaceId])
  if (!workspace.rowCount) return unavailable('The board workspace is unavailable.')
  if (scope.kind === 'workflow') {
    const workflow = await tx.query('select id from workflows where id=$1 and workspace_id=$2',
      [scope.workflowId, scope.workspaceId])
    if (!workflow.rowCount) return unavailable('The board workflow is unavailable.')
  }
}

export const memoryBoardAuthority: MemoryBoardAuthority = {
  async caller(tx, principal) {
    if (principal.audience === 'operator') return null
    const binding = (await tx.query<{ execution_id: string }>(`select b.execution_id from worker_credential_bindings b
      join management_principals p on p.id=b.principal_id
      join harness_executions he on he.id=b.execution_id join runs r on r.id=b.run_id
      where b.principal_id=$1 and b.agent_id=$2 and b.purpose='workflow'
        and p.expires_at>clock_timestamp() and ${WORKER_BINDING_ELIGIBLE}`,
    [principal.id, principal.agentId])).rows[0]
    if (!binding) throw new DomainError('ACCESS_DENIED', 'Memory tools require a workflow credential.', 403)
    return subjectAccess(tx, (await memoryExecution(tx, binding.execution_id)).subject)
  },
  subject: subjectAccess,
  scope: assertScope,
  async node(tx, node, scope) {
    if (node.workspaceId !== scope.workspaceId || scope.kind === 'workflow' && node.workflowId !== scope.workflowId) {
      throw new DomainError('ACCESS_DENIED', 'The selected Agent is outside this board.', 403)
    }
    const found = await tx.query(`select w.id from workflows w
      join workflow_versions v on v.id=w.current_version_id
      join lateral jsonb_array_elements(v.record->'definition'->'nodes') n on true
      where w.id=$1 and w.workspace_id=$2 and n->>'id'=$3 and n->>'agentId'=$4`,
    [node.workflowId, node.workspaceId, node.workflowNodeId, node.agentId])
    if (!found.rowCount) return unavailable('The selected Agent is not in the saved workflow.')
  },
  work: resolveMemoryWork,
  async currentWork(tx, subject) {
    if (subject.kind !== 'execution') return null
    const saved = await memoryExecution(tx, subject.execution.executionId)
    return resolveMemoryWork(tx, saved.work)
  },
  async sourcePost() {
    throw new DomainError('SOURCE_POST_UNAVAILABLE', 'Group chat sources are not available.', 409)
  },
  async lifecycle(tx, agent, work, executionId) {
    const resolved = await resolveMemoryWork(tx, work)
    const saved = await memoryExecution(tx, executionId ?? resolved.currentExecutionId!)
    if (!sameAgentNode(agent, saved.subject.agent) || !sameAgentNode(agent, resolved.node)
      || saved.work.runId !== work.runId || saved.work.workflowVersionId !== work.workflowVersionId
      || saved.work.kind !== work.kind
      || (work.kind === 'activation' && saved.work.kind === 'activation' && saved.work.activationId !== work.activationId)
      || (work.kind === 'slot' && saved.work.kind === 'slot' && saved.work.slotId !== work.slotId)) {
      throw new DomainError('EXECUTION_IDENTITY_CONFLICT', 'The board fact belongs to another logical work item.', 409)
    }
  },
}

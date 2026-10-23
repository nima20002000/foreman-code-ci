import type pg from 'pg'
import type { AcceptedProviderAccountBinding } from '@foreman-code/contracts/provider-accounts'
import { WorkflowVersionCurrentSchema } from '@foreman-code/contracts/current'
import { DomainError } from '../errors.js'
import type { NativeManagerResolutionContext } from '../interactions/runtimePorts.js'
import type { createProductionRemoteWorkflow } from '../placement/productionRemoteWorkflow.js'
import type { ProviderAccountsService } from '../provider-accounts/service.js'

/** The saved workflow version and node an execution runs, if the Run owns that execution. */
export async function readExecutionWorkflowNode(pool: Pick<pg.Pool, 'query'>, executionId: string, runId: string) {
  const row = (await pool.query<{ version: unknown; node_id: string }>(
    `select v.record as version,e.workflow_node_id as node_id from harness_executions e
       join runs r on r.id=e.run_id join workflow_versions v on v.id=r.workflow_version_id
       where e.id=$1 and r.id=$2`, [executionId, runId])).rows[0]
  return row && { version: WorkflowVersionCurrentSchema.parse(row.version), nodeId: row.node_id }
}

/**
 * Completes the context a workflow manager is resolved with: its placement, the provider account the node runs under,
 * and the node's declared artifact outputs.
 */
export function createWorkflowManagerContextPreparer(dependencies: {
  pool: pg.Pool
  remoteWorkflow: Pick<ReturnType<typeof createProductionRemoteWorkflow>, 'prepareContext'>
  providerAccounts: Pick<ProviderAccountsService, 'runtimeBinding'>
  /** Receives the account binding accepted for each execution. */
  workflowAccountBindings: Map<string, AcceptedProviderAccountBinding>
}) {
  const { pool, remoteWorkflow, providerAccounts, workflowAccountBindings } = dependencies
  return async (context: NativeManagerResolutionContext) => {
    const prepared = await remoteWorkflow.prepareContext(context)
    if (!context.runId) return prepared
    const execution = await readExecutionWorkflowNode(pool, context.executionId, context.runId)
    if (!execution) throw new DomainError('WORKFLOW_ARTIFACT_SOURCE_UNAVAILABLE', 'The saved native execution is unavailable.', 409)
    const binding = await providerAccounts.runtimeBinding('run-node', context.purpose
      ? `${context.runId}:agent:${context.configuration.agentId}` : `${context.runId}:${execution.nodeId}`,
    context.configuration.harness, context.configuration.harnessProfileSelection)
    if (binding) workflowAccountBindings.set(context.executionId, binding)
    if (context.purpose) return prepared
    const node = execution.version.definition.nodes.find(item => item.id === execution.nodeId)
    return node && node.kind !== 'job' && node.artifactOutputs
      ? { ...prepared, artifactOutputs: node.artifactOutputs } : prepared
  }
}

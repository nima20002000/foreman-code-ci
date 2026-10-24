import { agentWorkflowVersion } from './agentWorkflowFixture.js'
import { insertProviderRun, providerLaunchCredentials, providerAppEndpoint, stopProviderRun } from './checkpointRuntime.js'
import { codexMcpInspectorAdapter } from '../../src/modules/harnesses/codexMcpInspectorAdapter.js'
import { CodexAppServerSessionManager } from '../../src/modules/harnesses/codexAppServer.js'
import { createWorkflowNativeCaptureChannel } from '../../src/modules/interactions/workflowNativeCapture.js'
import { createReviewNativeCaptureChannel } from '../../src/modules/interactions/reviewNativeCapture.js'
import { ReviewNativeProofServices } from '../../src/modules/interactions/reviewNativeProof.js'
import { PostgresRepeatReviewerBindings } from '../../src/modules/interactions/repeatReviewer.js'
import { PostgresWorkflowClosureStore } from '../../src/modules/interactions/workflowClosure.js'
import { createWorkflowRepositoryServices } from '../../src/modules/runs/workflowRepositoryServices.js'
import { randomUUID } from 'node:crypto'
import { vi } from 'vitest'
import { AgentConfigurationVersionSchema, DEFAULT_HARNESS_DEFAULTS } from '@foreman-code/contracts'
import { ExecutableWorkflowCurrentSchema, makeCurrentWorkflowFixture, WorkflowRunCurrentSchema } from '@foreman-code/contracts/current'
import { ApprovalPostgresSaver } from '../../src/modules/runs/approvalCheckpointSaver.js'
import { PostgresAccessService } from '../../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../../src/modules/commands/postgres.js'
import { PostgresApprovalBudgetRepository } from '../../src/modules/interactions/budget.js'
import { ApprovalExecutionCoordinator } from '../../src/modules/interactions/execution.js'
import { InteractionService } from '../../src/modules/interactions/service.js'
import { ExecutionScopedNativeSessionManagerResolver } from '../../src/modules/interactions/runtimePorts.js'
import { CurrentInteractionRepository } from '../../src/modules/interactions/current/repository.js'
import { CurrentWorkerCredentialService } from '../../src/modules/interactions/current/credentials.js'
import { registerApprovalCheckpointResume } from '../../src/modules/runs/approvalCheckpointRegistration.js'
import { continuationValidator } from '../../src/modules/runs/continuation.js'
import { LangGraphWorkflowEngine } from '../../src/modules/runs/engine.js'
import { PostgresRunRepository } from '../../src/modules/runs/postgres.js'
import { PostgresWorkflowRepository } from '../../src/modules/workflows/postgres.js'
import { WorkspaceLocationService } from '../../src/modules/workspaces/location.js'
import { deliveryFixture } from '../fixtures/codex-delivery.js'
import { NativeResponseJournal } from '../../src/modules/harnesses/recovery/responseJournal.js'
import { join } from 'node:path'
import { seedWorkflowFixture } from './workflowDatabase.js'
import { migratedDatabase } from './migratedDatabase.js'

/** Real Codex manager, stdio, workflow engine, SQL owner, checkpoint and delivery services.
 * The executable provider fixture substitutes model execution and installation qualification. */
export async function codexWorkflowRuntime(kind: 'questions' | 'form') {
  const db = await migratedDatabase()
  let engine: LangGraphWorkflowEngine | undefined
  const provider = await deliveryFixture()
  const journal = new NativeResponseJournal(join(provider.directory, 'response-journal'))
  try {
    await provider.json('mcp.json', { name: 'foreman-code', enabled: true, required: true,
      transport: { type: 'streamable_http', url: providerAppEndpoint, bearer_token_env_var: 'GRAPHQL_MCP_TOKEN' } })
    await provider.json('workflow-input.json', kind === 'questions'
      ? { method: 'item/tool/requestUserInput', params: { itemId: 'question-tool', isBlocking: true,
        questions: [{ id: 'answer', header: 'Answer', question: 'What should happen next?',
          isOther: true, isSecret: false, options: null }] } }
      : { method: 'mcpServer/elicitation/request', params: { mode: 'form', serverName: 'app', message: 'Enter details',
        requestedSchema: { type: 'object', properties: { count: { type: 'integer', minimum: 1 } }, required: ['count'] } } })
    const f = makeCurrentWorkflowFixture(randomUUID(), 'single')
    const approval = { handler: 'user' as const }
    f.configurations = f.configurations.map(c => AgentConfigurationVersionSchema.parse({ ...c,
      harness: { ...DEFAULT_HARNESS_DEFAULTS.codex, model: 'test-model', reasoningEffort: 'low',
        sandbox: 'read-only', serviceTier: 'standard' } }))
    f.version.approval = approval
    f.version.definition.approval = approval
    f.version = agentWorkflowVersion(ExecutableWorkflowCurrentSchema.parse({ version: f.version, configurations: f.configurations }).version)
    f.run = WorkflowRunCurrentSchema.parse({ ...f.run, approval, agentConfigurationVersionIds: f.version.agentConfigurationVersionIds })
    await seedWorkflowFixture(db.pool, provider.directory, f, { run: false })
    const access = new PostgresAccessService(db.pool)
    const authority = await access.issue({ name: 'Codex workflow Run authority', audience: 'operator',
      expiresAt: new Date(Date.now() + 600000), grants: [
        { actions: ['runs:start', 'runs:stop'], scope: { workspaceIds: [f.scope.workspaceId], workflowIds: [f.scope.workflowId] } },
        { actions: ['workspace_locations:read'], scope: { workspaceIds: [f.scope.workspaceId] } },
      ] })
    f.run = WorkflowRunCurrentSchema.parse({ ...f.run, authorizationPrincipalId: authority.principal.id })
    await insertProviderRun(db.pool, f)
    const managers = new ExecutionScopedNativeSessionManagerResolver(() =>
      provider.makeManager(undefined, {}, { appMcpAccess: 'scoped', responseJournal: journal }))
    const saver = new ApprovalPostgresSaver(db.pool, undefined, { schema: db.schema })
    await saver.setup()
    const workflows = new PostgresWorkflowRepository(db.pool)
    const locations = new WorkspaceLocationService(db.pool, new PostgresCommandCoordinator(db.pool))
    vi.spyOn(locations, 'revalidateSnapshot').mockResolvedValue(undefined)
    const workflowCapture = createWorkflowNativeCaptureChannel()
    const nativeCapture = { capture: workflowCapture.capture.capture.bind(workflowCapture.capture) }
    const reviewCapture = createReviewNativeCaptureChannel()
    const runs = new PostgresRunRepository(db.pool, workflows, locations,
      { runtimeRoot: db.directory, ...createWorkflowRepositoryServices(workflowCapture.verify) })
    const repository = new CurrentInteractionRepository(db.pool, new ReviewNativeProofServices(reviewCapture.verify)), budgets = new PostgresApprovalBudgetRepository(db.pool)
    const credentials = new CurrentWorkerCredentialService(db.pool, access)
    const launchCredentials = providerLaunchCredentials(runs, locations, managers, credentials,
      manager => {
        if (!(manager instanceof CodexAppServerSessionManager)) throw new Error('Expected the Codex workflow manager')
        return codexMcpInspectorAdapter(manager)
      }, db.pool)
    const native = new ApprovalExecutionCoordinator({ runs, interactions: repository, budgets, managers, activeTimeoutMs: 600000,
      credentials: launchCredentials, validateContinuation: continuationValidator(db.pool, locations),
      workflowClosures: new PostgresWorkflowClosureStore(db.pool), repeatReviewerBindings: new PostgresRepeatReviewerBindings(db.pool),
      nativeCaptures: nativeCapture, reviewNativeCaptures: reviewCapture.capture })
    engine = new LangGraphWorkflowEngine(runs, workflows, native, saver, db.directory,
      locations, launchCredentials, repository, undefined, { workerParallelism: 2 })
    const activeEngine = engine
    const service = new InteractionService(repository, budgets, native, (i) => activeEngine.resumeInteraction(i), journal)
    registerApprovalCheckpointResume(service, engine)
    const config = { configurable: { thread_id: f.run.id } }
    return { db, f, engine, native, runs, repository, service, saver, config, provider, journal, credentials, access,
      nativeCapture, nativeVerification: workflowCapture.verify,
      authorizationPrincipalId: authority.principal.id,
      stop: () => stopProviderRun(runs, f, authority.principal.id),
      async pending() { return repository.list({ runId: f.run.id, limit: 100 }) },
      async receipts() { return (await db.pool.query(`select entity_id,effect_digest,first_sequence::text
        from run_graph_effects where run_id=$1 and effect_kind='graph.resume' order by entity_id`, [f.run.id])).rows },
      async close() {
        try { await activeEngine.shutdown() }
        finally { try { await provider.close() } finally { await db.close() } }
      } }
  } catch (error) {
    try { await engine?.shutdown() } finally {
      try { await provider.close() } finally { await db.close() }
    }
    throw error
  }
}

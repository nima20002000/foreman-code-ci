import { beforeEach, expect, it } from 'vitest'
import { randomUUID } from 'node:crypto'
import pg from 'pg'
import { AgentConfigurationVersionSchema, canonicalJson } from '@foreman-code/contracts'
import { PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { conversationFeatureContext } from '../src/modules/conversations/conversationFeatureSubject.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { Wave25WorkerCredentialService } from '../src/modules/interactions/current/credentials.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { workerCredentialBudgetFixture } from './helpers/workerCredentialBudgetFixture.js'

/** Thrown to roll the lock-holding transaction back once the busy-row checks are done. */
class ReleaseLock extends Error {}

const fixture = workerCredentialBudgetFixture()
let schema: typeof fixture.schema
let pool: typeof fixture.pool
let execution: typeof fixture.execution
let access: typeof fixture.access
let credentials: typeof fixture.credentials
const connectionString = process.env.TEST_DATABASE_URL!

beforeEach(() => {
  ({ schema, pool, execution, access, credentials } = fixture)
})

for (const lockedRow of ['run', 'execution', 'principal', 'binding'] as const) {
  it(`defers credential reconciliation while the ${lockedRow} is busy, then revokes on the next sweep`, async () => {
    const issued = await credentials.issueForExecution(execution.id)
    await pool.query('update runs set worker_credentials_closed_at=now() where id=$1', [execution.runId])
    const sweepPool = new pg.Pool({ connectionString,
      options: `-c search_path=${schema} -c statement_timeout=500` })
    const reconciler = new Wave25WorkerCredentialService(sweepPool, new PostgresAccessService(sweepPool))
    const revoked = async () => (await pool.query(`select p.revoked_at is not null as principal_revoked,
      b.revoked_at is not null as binding_revoked from management_principals p
      join worker_credential_bindings b on b.principal_id=p.id where p.id=$1`, [issued.principalId])).rows[0]
    try {
      await withTransaction(pool, async blocker => {
        if (lockedRow === 'run') {
          await blocker.query('select id from runs where id=$1 for update', [execution.runId])
        } else if (lockedRow === 'execution') {
          await blocker.query('select id from harness_executions where id=$1 for update', [execution.id])
        } else if (lockedRow === 'principal') {
          await blocker.query('select id from management_principals where id=$1 for update', [issued.principalId])
        } else {
          await blocker.query('select principal_id from worker_credential_bindings where principal_id=$1 for update',
            [issued.principalId])
        }
        await expect(reconciler.reconcileTerminalCredentials()).resolves.toBeUndefined()
        expect(await revoked()).toEqual({ principal_revoked: false, binding_revoked: false })
        // Deferral never makes a stopped execution's token usable.
        await expect(access.authenticate(issued.environment.variables.GRAPHQL_MCP_TOKEN!, 'worker'))
          .rejects.toMatchObject({ code: 'AUTH_REVOKED' })
        throw new ReleaseLock()
      }).catch((error: unknown) => { if (!(error instanceof ReleaseLock)) throw error })
      await reconciler.reconcileTerminalCredentials()
      expect(await revoked()).toEqual({ principal_revoked: true, binding_revoked: true })
    } finally {
      await sweepPool.end()
    }
  })
}

it('keeps a live Agent chat credential through the terminal credential sweep', async () => {
  const issued = await access.issue({ name: 'Agent conversation sweep', audience: 'worker', agentId: 'agent-developer',
    expiresAt: new Date('2099-01-01T00:00:00Z'), grants: [{ actions: ['agent_chat:read'],
      scope: { workspaceIds: ['workspace-1'], workflowIds: ['workflow-content-pipeline'] } }] })
  const conversationId = `agent-chat-sweep-${randomUUID()}`
  await pool.query(`insert into operator_conversations(id,kind,agent_key,workspace_id,workflow_id,workflow_node_id,agent_id,
    agent_configuration_version_id,harness,record) values($1,'agent',$1,'workspace-1','workflow-content-pipeline','node-developer',
    'agent-developer','agent-developer-config-v1','claude','{}'::jsonb)`, [conversationId])
  const row = (await new PostgresAgentChatRepository(pool).get(conversationId))!
  const configuration = (await pool.query<{ record: unknown }>('select record from agent_configuration_versions where id=$1',
    [row.agent_configuration_version_id])).rows[0]!
  const { subject } = await conversationFeatureContext(pool, row, AgentConfigurationVersionSchema.parse(configuration.record),
    'workflow-content-pipeline-v1')
  await pool.query(`insert into agent_conversation_credentials(principal_id,conversation_id,subject,workflow_version_id)
    values($1,$2,$3::jsonb,'workflow-content-pipeline-v1')`, [issued.principal.id, conversationId, canonicalJson(subject)])
  await credentials.reconcileTerminalCredentials()
  await expect(access.authenticate(issued.token, 'worker')).resolves.toMatchObject({ id: issued.principal.id })
})

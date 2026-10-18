import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client'
import { CiGetOutputSchema, CiRunRecordSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { afterAll, beforeAll, expect, it } from 'vitest'
import { buildApp } from '../src/app.js'
import type { OperatorServices } from '../src/mcp/operator/types.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresCommandCoordinator } from '../src/modules/commands/postgres.js'
import { fixture } from '../src/modules/ci-host/cloud.testSupport.js'
import { saveCloudRun } from '../src/modules/ci-host/cloudJournal.js'
import { HostCiService, type CiCommits, type HostCiComputer } from '../src/modules/ci-host/service.js'
import { CI_GET_ACTIONS, RunCiAuthority } from '../src/modules/jobs/ciAuthority.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'

let database: Awaited<ReturnType<typeof migratedDatabase>>
beforeAll(async () => { database = await migratedDatabase() }, 60_000)
afterAll(async () => { await database?.close() }, 60_000)

it('releases an existing deadline-failed cloud ticket after complete empty discovery and stops refreshing it', async () => {
  const f = await fixture()
  const workspaceId = randomUUID()
  const runId = randomUUID()
  const executionRunId = randomUUID()
  const at = new Date(Date.now() - 24 * 60 * 60_000).toISOString()
  const computer: HostCiComputer = { key: 'cloud-0', label: 'Cloud executor', priority: 30,
    hostRef: { kind: 'cloud', mainId: 'main-1', provider: 'github', slot: 0 } }
  await saveCloudRun(join(f.root, 'ci-cloud', 'runs', executionRunId, 'meta.json'), {
    runId: executionRunId, repository: 'octo/site', mirror: 'octo/site-ci', commit: f.commit,
    suite: 'lint', state: 'starting', startedAt: at, finishedAt: null, exitCode: null, providerRunId: null,
    message: 'Cancellation requested; waiting for the provider to stop.',
    dispatch: { attempts: 1, at, uncertain: true }, dispatchHistory: [],
    cancellation: { at, canceledIds: [], requeue: false },
  })
  const record = CiRunRecordSchema.parse({
    id: runId, workspaceId, groupId: randomUUID(), executionRunId, repository: 'octo/site', commit: f.commit,
    suite: 'lint', part: null, scope: 'affected', files: [], partition: null,
    state: 'failed', computer: { hostRef: computer.hostRef, label: computer.label }, step: null,
    exitCode: null, message: 'CI_START_DEADLINE_EXCEEDED: cleanup is unconfirmed.', collection: 'failed',
    queuedAt: at, startedAt: at, finishedAt: at,
    initiator: { principalId: 'operator', executionId: null },
    deadlineExceeded: { code: 'CI_START_DEADLINE_EXCEEDED', cause: 'cleanup pending', phase: 'starting',
      executor: 'retained', enteredAt: at, deadlineAt: at, detectedAt: at },
    observation: { status: 'unavailable', lastSuccessAt: at, lastError: 'cleanup pending',
      consecutiveFailures: 2060, nextAttemptAt: at },
  })
  await database.pool.query('insert into workspaces(id,record) values($1,$2::jsonb)', [workspaceId,
    JSON.stringify({ id: workspaceId, name: 'Cleanup workspace', repository: {
      provider: 'github', owner: 'octo', name: 'site', defaultBranch: 'main',
    } })])
  await database.pool.query(`insert into ci_runs(id,workspace_id,group_id,state,host_key,record)
    values($1,$2,$3,$4,$5,$6::jsonb)`,
  [runId, workspaceId, record.groupId, record.state, computer.key, JSON.stringify(record)])
  let observations = 0
  const commands = new PostgresCommandCoordinator(database.pool)
  const ci = new HostCiService(database.pool, commands, new RunCiAuthority(database.pool), {} as CiCommits, {
    computers: async () => [computer], request: async (_computer, request) => {
      if (request.operation !== 'status') observations++
      return f.reopen().handle(request)
    },
  })
  const access = new PostgresAccessService(database.pool)
  const app = buildApp({ logger: false,
    readiness: { database: { ping: async () => {} }, checkpoints: { ping: async () => {} } },
    operator: { access, services: { commands, ci } as unknown as OperatorServices } })
  const client = new Client({ name: 'cloud-cleanup-test', version: '1' })
  const denied = new Client({ name: 'cloud-cleanup-denied', version: '1' })
  try {
    const address = await app.listen({ host: '127.0.0.1', port: 0 })
    for (const [connection, allowedWorkspace] of [[client, workspaceId], [denied, randomUUID()]] as const) {
      const issued = await access.issue({ name: 'CI reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000),
        grants: [{ actions: CI_GET_ACTIONS, scope: { workspaceIds: [allowedWorkspace] } }] })
      await connection.connect(new StreamableHTTPClientTransport(new URL('/mcp', address), {
        requestInit: { headers: { authorization: `Bearer ${issued.token}` } },
      }))
    }
    await ci.dispatch()
    await ci.drain()
    const input = { name: 'ci_get', arguments: { workspaceId, ticketId: runId } }
    expect((await denied.callTool(input)).isError).toBe(true)
    const reply = await client.callTool(input)
    expect(reply.isError).not.toBe(true)
    const recovered = CiGetOutputSchema.parse(decodeMcpToolResult(reply)).run
    expect(recovered).toMatchObject({ state: 'failed', message: record.message, finishedAt: at,
      deadlineExceeded: { executor: 'released' }, executorCleanupPending: false,
      observation: { status: 'available', consecutiveFailures: 0, nextAttemptAt: null, lastError: null } })
    const stored = (await database.pool.query('select record,host_key from ci_runs where id=$1', [runId])).rows[0]
    expect(stored).toEqual({ record: recovered, host_key: null })
    const count = observations
    await ci.dispatch()
    await ci.drain()
    expect(observations).toBe(count)
  } finally {
    await client.close()
    await denied.close()
    await ci.close()
    await app.close()
  }
})

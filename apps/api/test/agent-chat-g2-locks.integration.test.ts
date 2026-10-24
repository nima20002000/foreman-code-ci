import { migratedDatabase } from './helpers/migratedDatabase.js'
import { readUntil } from './helpers/observableCondition.js'
import { AgentHarnessSchema } from '@foreman-code/contracts'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import type pg from 'pg'
import { afterAll, beforeAll, beforeEach, describe, it } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/current'
import { agentChatKey, PostgresAgentChatRepository } from '../src/modules/conversations/agentChatRepository.js'
import { seedWorkflowFixture } from './helpers/workflowDatabase.js'
import { postgresEnabled } from './helpers/database.js'
import { beginTransaction, commitTransaction, rollbackTransaction } from '../src/infrastructure/transaction.js'

/** Real, independent PostgreSQL sessions. No app server, HTTP transport or native provider.
 * The shared helper owns a separate migrated database on the disposable loopback server. */
describe.skipIf(!postgresEnabled)('G2 A2-PF-06: acknowledgement / unknown PostgreSQL lock interleavings', () => {
  let database: Awaited<ReturnType<typeof migratedDatabase>>
  let seeded: ReturnType<typeof makeCurrentWorkflowFixture>
  beforeAll(async () => {
    database = await migratedDatabase()
    seeded = await seedWorkflowFixture(database.pool, database.directory, makeCurrentWorkflowFixture(`g2-${randomUUID()}`, 'single'), { run: false })
  })
  beforeEach(async () => {
    await database.pool.query(`delete from operator_conversations where kind='agent' and workspace_id=$1`, [seeded.scope.workspaceId])
  })
  afterAll(async () => { await database?.close() })

  async function setup(steer: boolean) {
    const node = seeded.version.definition.nodes[0]!
    const configuration = seeded.configurations.find((entry) => entry.agentId === node.agentId)!
    const context = { workspaceId: seeded.scope.workspaceId, workflowId: seeded.scope.workflowId, workflowNodeId: node.id, agentId: node.agentId }
    const query = { workflowId: context.workflowId, workflowNodeId: context.workflowNodeId, agentId: context.agentId }
    const repository = new PostgresAgentChatRepository(database.pool)
    const admitted = await repository.admit({ key: agentChatKey(context), context, delivery: 'queued',
      request: { requestId: 'A', content: 'G2 synthetic A', context: query, intent: 'next_turn', expectedConversationId: null },
      create: { context, agentConfigurationVersionId: configuration.id, harness: AgentHarnessSchema.parse(configuration.harness.harness),
        origin: { kind: 'fresh' }, workingDirectory: database.directory, runtimeDirectory: database.directory } })
    const id = admitted.conversationId
    assert.equal(await repository.claim(id, 'A'), true)
    // These are inert test identifiers, not a claim of a real native session.
    await repository.bindSession(id, 'g2-test-provider', 'g2-test-session')
    if (steer) {
      await repository.accepted(id, 'A', 'native-A')
      await repository.admit({ key: agentChatKey(context), context, delivery: 'submitting', targetNativeTurnId: 'native-A',
        request: { requestId: 'steer-A', content: 'G2 synthetic steer', context: query, intent: 'steer', expectedNativeTurnId: 'native-A', expectedConversationId: id } })
    }
    await repository.requestCancel(id, 'A')
    return { repository, id, requestId: steer ? 'steer-A' : 'A' }
  }

  /** Reserve one physical session per operation. The production repository still owns
   * BEGIN/COMMIT/ROLLBACK; only final client release is deferred to the test's finally. */
  function onClient(client: pg.PoolClient) {
    return new PostgresAgentChatRepository({ connect: async () => ({
      query: (sql: string, values?: unknown[]) => client.query(sql, values),
      release() {},
    }) } as unknown as pg.Pool)
  }
  async function waitForBlocker(blocker: number, blocked: number) {
    await readUntil(async () => {
      const result = await database.pool.query<{ blocked: boolean }>(
        'select $1::int = any(pg_blocking_pids($2::int)) as blocked', [blocker, blocked],
      )
      return result.rows[0]?.blocked ?? false
    }, value => value, { timeoutMs: 2000, description: 'the second PostgreSQL session waiting on the first' })
      .catch((error: unknown) => { assert.fail(error instanceof Error ? error : String(error)) })
  }

  for (const steer of [false, true]) {
    for (const firstOperation of ['acknowledgement', 'unknown'] as const) {
      it(`${steer ? 'steer' : 'turn'}: ${firstOperation} holds its first lock while the other operation enters`, async () => {
        const f = await setup(steer)
        const firstClient = await database.pool.connect(), secondClient = await database.pool.connect()
        const pending: Promise<unknown>[] = []
        const gateClient = await database.pool.connect()
        await beginTransaction(gateClient)
        await gateClient.query('select id from operator_conversations where id=$1 for update', [f.id])
        await gateClient.query('select request_id from operator_conversation_turns where conversation_id=$1 and request_id=$2 for update', [f.id, f.requestId])
        const gatePid = (await gateClient.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
        try {
          const firstPid = (await firstClient.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
          const secondPid = (await secondClient.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid
          const first = onClient(firstClient)
          const second = onClient(secondClient)
          const acknowledge = (repository: PostgresAgentChatRepository) => steer
            ? repository.steerAccepted(f.id, f.requestId, 'native-A') : repository.accepted(f.id, f.requestId, 'native-A')
          const unknown = (repository: PostgresAgentChatRepository) => repository.unknown(f.id, f.requestId, 'G2 uncertain transport')
          const firstTask = firstOperation === 'acknowledgement' ? acknowledge(first) : unknown(first)
          pending.push(firstTask); void firstTask.catch(() => /* ignore: marks the promise handled; the test awaits it below */ undefined)
          await waitForBlocker(gatePid, firstPid)
          const waitingRows = await database.pool.query<{ table_name: string }>(`select c.relname as table_name
            from pg_locks l join pg_class c on c.oid=l.relation
            where l.pid=$1 and l.locktype='tuple'`, [firstPid])
          assert.deepEqual(waitingRows.rows.map(row => row.table_name), ['operator_conversations'])
          const secondTask = firstOperation === 'acknowledgement' ? unknown(second) : acknowledge(second)
          pending.push(secondTask); void secondTask.catch(() => /* ignore: marks the promise handled; the test awaits it below */ undefined)
          // Both operations must queue at the conversation before touching the receipt.
          // PostgreSQL reports the second waiter behind the first tuple-lock owner.
          await waitForBlocker(firstPid, secondPid)
          await commitTransaction(gateClient)
          const results = await Promise.allSettled(pending)
          for (const result of results) {
            if (result.status === 'rejected') throw result.reason
          }
          // Unknown can mean missing settlement evidence even after acceptance. A later
          // positive ACK must still repair it, with exact native/cancellation ownership.
          await acknowledge(f.repository)
          const receipt = await f.repository.turn(f.id, f.requestId), row = await f.repository.get(f.id)
          assert.equal(receipt?.delivery, 'accepted')
          assert.equal(receipt?.nativeTurnId, 'native-A')
          assert.equal(receipt?.error, undefined)
          assert.equal(row?.active_request_id, 'A')
          assert.equal(row?.active_native_turn_id, 'native-A')
          assert.equal(row?.cancel_requested, true)
          assert.equal(row?.record.startupDelivered, true)
        } finally {
          await rollbackTransaction(gateClient)
          await Promise.allSettled(pending)
          gateClient.release()
          await rollbackTransaction(firstClient).catch(() => /* ignore: best-effort cleanup; the test outcome is already decided */ undefined)
          await rollbackTransaction(secondClient).catch(() => /* ignore: best-effort cleanup; the test outcome is already decided */ undefined)
          firstClient.release(); secondClient.release()
        }
      })
    }
  }
})

import { randomUUID } from 'node:crypto'
import { afterEach, expect, it } from 'vitest'
import { SyncRepository } from '../src/modules/computers/syncRepository.js'
import { PostgresAgentChatRepository, agentChatKey } from '../src/modules/conversations/agentChatRepository.js'
import { migratedDatabase } from './helpers/migratedDatabase.js'
import { seedWorkflowFixture } from './helpers/workflowDatabase.js'

const databases: Awaited<ReturnType<typeof migratedDatabase>>[] = []
afterEach(async () => { await Promise.all(databases.splice(0).map(database => database.close())) })

it('keeps the original computer participating while a historical chat continues', async () => {
  const database = await migratedDatabase()
  databases.push(database)
  const { pool, directory } = database
  const saved = await seedWorkflowFixture(pool, directory, undefined, { run: false })
  const mainId = randomUUID()
  const registration = { mainId, deviceId: randomUUID(), workerInstallationId: randomUUID(), keyRevision: 2,
    authorizationRevision: 3, status: 'paired', publicKeyFingerprint: 'a'.repeat(64), scopes: ['connect', 'heartbeat'] }
  await pool.query(`insert into device_registrations(id,main_id,worker_installation_id,public_key,record)
    values($1,$2,$3,'fixture',$4::jsonb)`, [registration.deviceId, mainId,
    registration.workerInstallationId, JSON.stringify(registration)])
  const host = { kind: 'device', mainId, deviceId: registration.deviceId }
  const node = saved.version.definition.nodes[0]!
  const configuration = saved.configurations.find(value => value.agentId === node.agentId)!
  const context = { workspaceId: saved.scope.workspaceId, workflowId: saved.scope.workflowId,
    workflowNodeId: node.id, agentId: node.agentId }
  const conversation = await new PostgresAgentChatRepository(pool).admit({ key: agentChatKey(context), context,
    delivery: 'queued', request: { requestId: randomUUID(), content: 'Continue the original chat',
      context, intent: 'next_turn', expectedConversationId: null },
    create: { context, agentConfigurationVersionId: configuration.id, harness: 'codex',
      origin: { kind: 'fresh' }, workingDirectory: directory, runtimeDirectory: directory } })
  await pool.query(`update operator_conversations set worker_conversation_binding=$2::jsonb where id=$1`,
    [conversation.conversationId, JSON.stringify({ profile: { target: {
      hostRef: host, applicationInstallationId: registration.workerInstallationId } },
    sourceExecution: { placement: { registration } } })])
  const repository = new SyncRepository(pool, mainId)
  const targets = async () => (await repository.workspaces()).find(row => row.id === context.workspaceId)!.targets
  expect(await targets()).toContainEqual({ hostRef: host,
    applicationInstallationId: registration.workerInstallationId, keyRevision: 2, authorizationRevision: 3 })
  await pool.query(`update operator_conversation_turns set delivery='completed' where conversation_id=$1`,
    [conversation.conversationId])
  expect(await targets()).toEqual([repository.mainTarget])
  await pool.query(`update operator_conversation_turns set delivery='queued' where conversation_id=$1`,
    [conversation.conversationId])
  // A historical row still bound to the former installation must not select its replacement.
  registration.workerInstallationId = randomUUID()
  await pool.query(`update device_registrations set worker_installation_id=$2,record=$3::jsonb where id=$1`,
    [registration.deviceId, registration.workerInstallationId, JSON.stringify(registration)])
  expect(await targets()).toEqual([repository.mainTarget])
})

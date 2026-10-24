import { afterEach, expect, it } from 'vitest'
import { operatorRepositoryFixture } from './helpers/operatorRepositoryFixture.js'
import { seedWorkflowFixture } from './helpers/workflowDatabase.js'

let current: Awaited<ReturnType<typeof fixture>> | undefined
afterEach(async () => { await current?.close(); current = undefined })

async function fixture(submitted = true) {
  const f = await operatorRepositoryFixture()
  const value = { ...f, ownerIdentity: { nativeSessionId: 'session', principalId: f.owner.id } }
  current = value
  await f.repository.bind(f.conversation.id, f.requestId, 'fixture', 'session')
  await f.repository.phase(f.conversation.id, f.requestId, 'submitting')
  if (submitted) expect(await f.repository.submitted(f.conversation.id, f.requestId, 'native-A', value.ownerIdentity)).toBe(true)
  return value
}

it('accepts the exact retained ACK repeatedly without a revision or receipt mutation', async () => {
  const f = await fixture()
  const before = await f.repository.get(f.conversation.id)
  const receipt = (await f.db.pool.query('select * from operator_conversation_turns where conversation_id=$1', [f.conversation.id])).rows
  for (let attempt = 0; attempt < 2; attempt++) expect(await f.repository.submitted(f.conversation.id, f.requestId, 'native-A', f.ownerIdentity)).toBe(true)
  expect(await f.repository.get(f.conversation.id)).toEqual(before)
  expect((await f.db.pool.query('select * from operator_conversation_turns where conversation_id=$1', [f.conversation.id])).rows).toEqual(receipt)
})

it('persists a first acknowledgement once before allowing identical observation', async () => {
  const f = await fixture(false)
  const before = await f.repository.get(f.conversation.id)
  expect(await f.repository.submitted(f.conversation.id, f.requestId, 'native-A', f.ownerIdentity)).toBe(true)
  const saved = await f.repository.get(f.conversation.id)
  expect(saved?.revision).toBe(before!.revision + 1)
  expect(await f.repository.submitted(f.conversation.id, f.requestId, 'native-A', f.ownerIdentity)).toBe(true)
  expect(await f.repository.get(f.conversation.id)).toEqual(saved)
})

it('accepts the exact repeated ACK without changing a pending cancellation', async () => {
  const f = await fixture()
  await f.db.pool.query("update operator_conversations set cancel_requested=true,turn_state='canceling' where id=$1", [f.conversation.id])
  const before = await f.repository.active(f.conversation.id)
  expect(await f.repository.submitted(f.conversation.id, f.requestId, 'native-A', f.ownerIdentity)).toBe(true)
  expect(await f.repository.active(f.conversation.id)).toEqual(before)
})

for (const scenario of ['different conversation', 'later request', 'different session', 'different principal', 'different native turn',
  'conflicting receipt', 'settled owner', 'deleted owner', 'Agent conversation', 'missing receipt']) {
  it(`refuses an identical-looking ACK under a ${scenario}`, async () => {
    const f = await fixture()
    let id = f.conversation.id, requestId = f.requestId, turnId = 'native-A'
    const owner = { ...f.ownerIdentity }
    if (scenario === 'different conversation') id = 'other'
    if (scenario === 'later request') requestId = 'later'
    if (scenario === 'different session') owner.nativeSessionId = 'replacement'
    if (scenario === 'different principal') owner.principalId = 'other'
    if (scenario === 'different native turn') turnId = 'other'
    if (scenario === 'conflicting receipt') await f.db.pool.query('update operator_conversation_turns set native_turn_id=$2 where conversation_id=$1', [id, 'other'])
    if (scenario === 'settled owner') await f.db.pool.query('update operator_conversations set active_request_id=null where id=$1', [id])
    if (scenario === 'deleted owner') await f.db.pool.query('update operator_conversations set deleted_at=now() where id=$1', [id])
    if (scenario === 'Agent conversation') {
      const workflow = await seedWorkflowFixture(f.db.pool, f.db.directory, undefined, { run: false })
      const configuration = workflow.configurations[0]!
      await f.db.pool.query(`update operator_conversations set kind='agent',operator_id=null,
        operator_configuration_version_id=null,owner_principal_id=null,agent_key='agent-context',workspace_id=$2,
        workflow_id=$3,workflow_node_id=$4,agent_id=$5,agent_configuration_version_id=$6 where id=$1`,
      [id, workflow.scope.workspaceId, workflow.scope.workflowId, workflow.version.entryNodeId, configuration.agentId, configuration.id])
    }
    if (scenario === 'missing receipt') await f.db.pool.query('delete from operator_conversation_turns where conversation_id=$1', [id])
    const before = (await f.db.pool.query('select * from operator_conversations where id=$1', [f.conversation.id])).rows
    expect(await f.repository.submitted(id, requestId, turnId, owner)).toBe(false)
    expect((await f.db.pool.query('select * from operator_conversations where id=$1', [f.conversation.id])).rows).toEqual(before)
  })
}

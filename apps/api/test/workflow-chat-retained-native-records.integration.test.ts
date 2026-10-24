import { expect, it } from 'vitest'
import { EngineChatReadbackSchema } from '@foreman-code/contracts'
import { sha256CanonicalJsonHex } from '../src/shared/hash.js'
import { readWorkflowControlCommandLocked } from '../src/modules/collaboration/index.js'
import { withExclusiveGraphConnection } from '../src/modules/run-graph/index.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { workflowChatCall, workflowChatTarget } from './helpers/workflowChatRequests.js'

it('reads retained native commands with retired channel metadata without changing persisted command facts', async () => {
  const provider = new ControlledWorkflowProvider(['builder'], (node, request) => coordinationOutput(node, request,
    node === 'master' ? { select: ['build'] } : {}))
  const f = await currentOperatorIntegration({ executionChat: true, fixture: hierarchyRuntimeFixture(),
    approvalNodeIds: [], collaborationPorts: {}, managerFactory: context => provider.connection(context) })
  const drive = f.engine.start(f.f.run.id).catch(error => error)
  try {
    await provider.entered('builder')
    const target = await workflowChatTarget(f, 'builder')
    const now = new Date().toISOString()
    const request = { commandId: 'retained-command', target, intent: 'next_turn', content: 'Original admitted input' }
    const receipt = { id: 'retained-native-command', commandId: request.commandId, target,
      requestedIntent: 'next_turn', appliedIntent: 'next_turn', state: 'completed', createdAt: now, updatedAt: now }
    await f.db.pool.query(`insert into run_chat_commands(id,command_id,principal_id,run_id,workflow_version_id,
      workflow_node_id,target,target_key,kind,operation,input_digest,request,state,receipt,created_at,updated_at)
      values($1,$2,$3,$4,$5,'builder',$6::jsonb,$7,'delivery','input','retained-input',$8::jsonb,'completed',$9::jsonb,$10,$10)`,
    [receipt.id, request.commandId, f.writer.principal.id, f.f.run.id, f.f.run.workflowVersionId,
      JSON.stringify(target), sha256CanonicalJsonHex(target), JSON.stringify({ ...request, sourcePostId: 'removed-post' }),
      JSON.stringify({ ...receipt, postId: 'removed-post', replyPostId: 'removed-reply' }), now])
    const persisted = (await f.db.pool.query('select * from run_chat_commands where id=$1', [receipt.id])).rows[0]
    const read = EngineChatReadbackSchema.parse(await workflowChatCall(f, 'agent_chat_read', { target }))
    expect(read.receipts).toContainEqual(receipt)
    const native = await withExclusiveGraphConnection(f.db.pool, connection => connection.transaction(sql =>
      readWorkflowControlCommandLocked(sql, f.f.run.id, receipt.id)))
    expect(native).toMatchObject({ request, receipt })
    expect((await f.db.pool.query('select * from run_chat_commands where id=$1', [receipt.id])).rows[0]).toEqual(persisted)
  } finally { provider.releaseAll(); await f.stop(); await drive; await f.close() }
}, 60_000)

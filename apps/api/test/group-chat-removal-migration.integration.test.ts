import { expect, it } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/current'
import { applyApplicationMigrations } from '../src/infrastructure/migrations.js'
import { removeGroupChatMigration } from '../src/infrastructure/removeGroupChatMigration.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { PostgresChatDeliveryRepository } from '../src/modules/workflow-chat/index.js'
import { memoryFixture } from '../src/modules/memory-boards/testing/fixture.js'
import { caller, target } from '../src/modules/workflow-chat/delivery.test-support.js'
import { currentDatabase } from './helpers/database.js'
import { seedWorkflowFixture } from './helpers/workflowDatabase.js'

it('removes seeded Group storage and retains direct receipts, native chat and exact saved workflow and Run facts', async () => {
  const db = await currentDatabase({ beforeMigration: removeGroupChatMigration.version })
  try {
    await seedWorkflowFixture(db.pool, db.directory, makeCurrentWorkflowFixture('group-removal', 'single'))
    const savedVersions = (await db.pool.query('select id,record from workflow_versions order by id')).rows
    const savedRuns = (await db.pool.query('select id,record from runs order by id')).rows
    const memory = memoryFixture(db.pool, { ...caller, audience: 'operator',
      grants: [{ actions: ['workflows:read', 'workflows:update'], scope: {} }] })
    const board = await memory.snapshot()
    const cardReceipt = await memory.create(board.board.id, 'Keep this task')
    const noteReceipt = await memory.service.mutate(memory.principal, { kind: 'note_create', boardId: board.board.id,
      commandId: 'keep-note', text: 'Keep this note' })
    await db.pool.query(`update memory_cards set record=record || '{"sourcePostId":"post"}'::jsonb where id=$1`, [cardReceipt.card!.id])
    await db.pool.query(`update memory_notes set record=record || '{"sourcePostId":"post"}'::jsonb where id=$1`, [noteReceipt.note!.id])
    await db.pool.query(`update memory_board_commands set receipt=jsonb_set(receipt,'{card,sourcePostId}','"post"'::jsonb)
      where command_id=$1`, [cardReceipt.commandId])
    await db.pool.query(`update memory_board_commands set receipt=jsonb_set(receipt,'{note,sourcePostId}','"post"'::jsonb)
      where command_id=$1`, [noteReceipt.commandId])
    const repository = new PostgresChatDeliveryRepository(db.pool)
    const request = { commandId: 'direct', target, intent: 'next_turn' as const, content: 'Retained direct input', attachments: [] }
    const direct = await withTransaction(db.pool, tx => repository.prepareLocked(tx, caller.id, request,
      { appliedIntent: 'next_turn', ownerBinding: {} }))
    await db.pool.query("insert into workflow_chat_channels(id,workspace_id,workflow_id) values('group','workspace','workflow')")
    await db.pool.query(`insert into workflow_chat_posts(id,channel_id,sequence,command_id,principal_id,input_hash,record)
      values('post','group',1,'group-post','user','post-hash','{}'::jsonb)`)
    await db.pool.query(`insert into chat_delivery_commands(id,command_id,principal_id,channel_id,post_id,target_hash,input_hash,request,receipt,owner_admission)
      values('group-delivery','group-command','user','group','post','target','input',$1::jsonb,$2::jsonb,'prepared')`,
    [JSON.stringify({ ...request, commandId: 'group-command', sourcePostId: 'post' }), JSON.stringify({ ...direct.receipt,
      id: 'group-delivery', commandId: 'group-command', postId: 'post' })])
    await db.pool.query(`insert into workflow_chat_projection_pending(source_event_key,workspace_id,workflow_id,fact)
      values('pending','workspace','workflow','{}'::jsonb)`)
    await db.pool.query("insert into workflow_chat_projection_keys(source_event_key,input_hash,post_id) values('key','hash','post')")
    await db.pool.query("insert into workflow_chat_projection_work(work_key,started_post_id) values('work','post')")
    await applyApplicationMigrations(db.pool)
    for (const name of ['workflow_chat_channels', 'workflow_chat_posts', 'workflow_chat_projection_pending',
      'workflow_chat_projection_keys', 'workflow_chat_projection_work']) {
      expect((await db.pool.query('select to_regclass($1) as relation', [name])).rows[0]?.relation).toBeNull()
    }
    expect(await repository.find(caller.id, 'group-command')).toBeUndefined()
    expect(await repository.find(caller.id, request.commandId)).toEqual(direct)
    for (const name of ['chat_delivery_commands', 'chat_control_commands', 'run_chat_commands', 'workflow_native_chat_items']) {
      expect((await db.pool.query('select to_regclass($1) as relation', [name])).rows[0]?.relation).toBeTruthy()
    }
    expect((await db.pool.query("select to_regprocedure('workflow_native_message_key(jsonb)') as function")).rows[0]?.function).toBeTruthy()
    expect((await memory.card(board.board.id, cardReceipt.card!.id)).card).toEqual(cardReceipt.card)
    expect(await memory.service.read(memory.principal, { boardId: board.board.id, view: 'notes' }))
      .toMatchObject({ items: [noteReceipt.note] })
    for (const receipt of [cardReceipt, noteReceipt]) {
      expect(await memory.service.read(memory.principal, { boardId: board.board.id, view: 'command', commandId: receipt.commandId }))
        .toEqual({ commandId: receipt.commandId, state: 'known', receipt })
    }
    expect((await db.pool.query('select id,record from workflow_versions order by id')).rows).toEqual(savedVersions)
    expect((await db.pool.query('select id,record from runs order by id')).rows).toEqual(savedRuns)
    await applyApplicationMigrations(db.pool)
    expect(await repository.find(caller.id, request.commandId)).toEqual(direct)
  } finally { await db.close() }
}, 30_000)

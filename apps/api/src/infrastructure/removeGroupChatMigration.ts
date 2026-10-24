/** Retire channel storage while retaining direct delivery and Run-native command journals. */
export const removeGroupChatMigration = { version: 2026102401, sql: `
  update memory_cards set record=record - 'sourcePostId' where record ? 'sourcePostId';
  update memory_notes set record=record - 'sourcePostId' where record ? 'sourcePostId';
  update memory_board_commands set receipt=jsonb_set(receipt,'{card}',(receipt->'card') - 'sourcePostId')
    where receipt->'card' ? 'sourcePostId';
  update memory_board_commands set receipt=jsonb_set(receipt,'{note}',(receipt->'note') - 'sourcePostId')
    where receipt->'note' ? 'sourcePostId';
  delete from chat_delivery_commands where channel_id is not null or post_id is not null or request ? 'sourcePostId';
  alter table chat_delivery_commands drop column channel_id, drop column post_id;
  drop table workflow_chat_projection_work;
  drop table workflow_chat_projection_keys;
  drop table workflow_chat_projection_pending;
  drop table workflow_chat_posts;
  drop table workflow_chat_channels;
` } as const

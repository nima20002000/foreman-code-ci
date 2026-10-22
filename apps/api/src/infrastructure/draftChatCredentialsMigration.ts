/** A chat on a never-saved workflow has no saved version yet; its browser still needs a scoped credential. */
export const draftChatCredentialsMigration = { version: 2026102232, sql: `
  alter table agent_conversation_credentials alter column workflow_version_id drop not null;
` } as const

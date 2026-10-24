import type pg from 'pg'
import { expect, it } from 'vitest'
import { DEFAULT_AGENT_DEFAULTS } from '@foreman-code/contracts'
import { PostgresFoundationSettingsRepository } from './foundation.js'

it.each(['coder', 'master'] as const)('reads saved %s role defaults with retired tool names without rewriting them', async role => {
  const saved = { ...structuredClone(DEFAULT_AGENT_DEFAULTS), [role]: { ...DEFAULT_AGENT_DEFAULTS.coder, role,
    graphqlTools: ['workflow_chat_read', 'context_get', 'workflow_chat_post'] } }
  const original = structuredClone(saved)
  const pool = { query: async () => ({ rows: [{ record: saved, revision: '3', current_version_id: 'saved-defaults' }] }) } as unknown as pg.Pool
  const result = await new PostgresFoundationSettingsRepository(pool).getAgentDefaults()
  expect(result.value[role]!.graphqlTools).toEqual(['workflow_chat_read', 'context_get', 'workflow_chat_post'])
  expect(result.revision).toBe(3)
  expect(result.versionId).toBe('saved-defaults')
  expect(saved).toEqual(original)
})

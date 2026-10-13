import { expect, it } from 'vitest'
import { AgentDefaultsSchema, DEFAULT_AGENT_DEFAULTS, DEFAULT_HARNESS_DEFAULTS, HarnessDefaultsSchema,
  CodexHarnessConfigurationSchema } from './index.js'
import { DEFAULT_MANAGEMENT_ACTIONS, ManagementGrantSchema, ManagementHarnessDefaultsSchema } from './management/index.js'

it('keeps full CI out of defaults and accepts only explicit scoped grants and Agent settings', () => {
  expect(DEFAULT_MANAGEMENT_ACTIONS).not.toContain('jobs:ci_full')
  expect(ManagementGrantSchema.parse({ actions: ['jobs:ci_full'], scope: { workspaceIds: ['workspace'] } }).actions)
    .toEqual(['jobs:ci_full'])
  const configuration = { ...DEFAULT_HARNESS_DEFAULTS.codex, ciFullScope: true }
  expect(CodexHarnessConfigurationSchema.parse(configuration).ciFullScope).toBe(true)
  expect(DEFAULT_HARNESS_DEFAULTS.codex.ciFullScope).toBeUndefined()
  expect(HarnessDefaultsSchema.safeParse({ codex: configuration }).success).toBe(false)
  expect(ManagementHarnessDefaultsSchema.safeParse({ codex: configuration }).success).toBe(false)
  expect(AgentDefaultsSchema.safeParse({ ...DEFAULT_AGENT_DEFAULTS,
    coder: { ...DEFAULT_AGENT_DEFAULTS.coder, harness: configuration } }).success).toBe(false)
})

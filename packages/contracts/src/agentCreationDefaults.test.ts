import { describe, expect, it } from 'vitest'
import { AgentDefaultsSchema, RecordedAgentDefaultsSchema, activeAgentDefaults, DEFAULT_AGENT_DEFAULTS, agentTemplateForRole } from './index.js'
import { effectiveForemanTools, foremanRoleTools, newAgentForemanTools } from './foremanMcpTools.js'
import { memoryBoardTools } from './collaborationTools.js'
import { AgentDefaultsUpdateInputSchema } from './management/index.js'

describe('new Agent memory defaults and preserved saved choices', () => {
  it('does not accept retired tool names in new role defaults', () => {
    const value = { ...DEFAULT_AGENT_DEFAULTS, coder: { ...DEFAULT_AGENT_DEFAULTS.coder,
      graphqlTools: ['workflow_chat_read', 'workflow_chat_post'] } }
    expect(AgentDefaultsUpdateInputSchema.safeParse({ value }).success).toBe(false)
    expect(RecordedAgentDefaultsSchema.parse(value)).toEqual(value)
    expect(activeAgentDefaults(value).coder.graphqlTools).toEqual([])
    expect(agentTemplateForRole(value, 'coder').graphqlTools).toEqual([])
    expect(value.coder.graphqlTools).toEqual(['workflow_chat_read', 'workflow_chat_post'])
  })
  it.each(['master', 'orchestrator', 'coder'] as const)('copies the %s memory default only on explicit creation', role => {
    const access = 'write'
    expect(newAgentForemanTools(role)).toEqual([...foremanRoleTools(role), ...memoryBoardTools(access)])
    expect(effectiveForemanTools(role, undefined, undefined, false, memoryBoardTools('write')))
      .not.toEqual(expect.arrayContaining(memoryBoardTools('read')))
    expect(effectiveForemanTools(role, newAgentForemanTools(role))).toEqual(foremanRoleTools(role))
    expect(effectiveForemanTools(role, newAgentForemanTools(role), undefined, false, memoryBoardTools('write')))
      .toEqual(expect.arrayContaining(memoryBoardTools(access)))
    expect(effectiveForemanTools(role, [], undefined, false, memoryBoardTools('write'))).toEqual(['bug_report'])
  })

  it.each(['master', 'orchestrator', 'coder'] as const)('gives a %s with memory on read and write unless its workflow node narrows it', role => {
    const savedRead = [...foremanRoleTools(role), ...memoryBoardTools('read')]
    const implemented = memoryBoardTools('write')
    expect(effectiveForemanTools(role, savedRead, undefined, false, implemented))
      .toEqual(expect.arrayContaining(memoryBoardTools('write')))
    const narrowed = { add: [], remove: memoryBoardTools('write').filter(tool => !memoryBoardTools('read').includes(tool)) }
    const read = effectiveForemanTools(role, savedRead, narrowed, false, implemented)
    expect(read).toEqual(expect.arrayContaining(memoryBoardTools('read')))
    expect(read).not.toContain('memory_card_create')
  })

  it('preserves old defaults byte-for-byte and uses explicit Master templates before the old Orchestrator fallback', () => {
    const old = structuredClone(DEFAULT_AGENT_DEFAULTS)
    expect(agentTemplateForRole(old, 'master')).toEqual({ ...old.orchestrator, role: 'master' })
    expect(old).toEqual(DEFAULT_AGENT_DEFAULTS)
    expect(old.master).toBeUndefined()
    const updated = AgentDefaultsSchema.parse({ ...old,
      master: { ...old.orchestrator, role: 'master', graphqlTools: [] },
      coder: { ...old.coder, graphqlTools: memoryBoardTools('write') },
    })
    expect(agentTemplateForRole(updated, 'master').graphqlTools).toEqual([])
    expect(agentTemplateForRole(updated, 'coder').graphqlTools).toEqual(memoryBoardTools('write'))
    expect(AgentDefaultsSchema.safeParse({ ...old,
      operator: { ...old.operator, graphqlTools: memoryBoardTools('read') } }).success).toBe(false)
  })
})

import { OperatorToolNameSchema, AgentCreateInputSchema, AgentUpdateInputSchema } from './management/index.js'
import { describe, expect, it } from 'vitest'
import { AgentSchema } from './index.js'
import { activeForemanTools, activeForemanToolOverride, effectiveForemanTools, foremanRoleTools, foremanToolRoles,
  ForemanToolDefaultsSchema, ForemanToolOverrideSchema, FOREMAN_OPERATOR_TOOLS } from './foremanMcpTools.js'
import { CurrentWorkflowNodeSchema } from './current/workflowShape.js'
import { CurrentWorkflowCreateInputSchema, CurrentWorkflowSaveInputSchema } from './current/currentAuthoring.js'
import { makeCurrentWorkflowFixture } from './current/currentFixture.js'
import { ExecutableWorkflowCurrentSchema } from './current/repeatAdmission.js'
import { WORKER_NATIVE_OUTPUT_TOOL_NAMES } from './workerNativeOutput.js'

describe('Foreman Code MCP tools per Agent', () => {
  it('starts from every role tool, applies the Agent default, then the node override, never beyond the role', () => {
    const outputs = Object.values(WORKER_NATIVE_OUTPUT_TOOL_NAMES)
    expect(foremanRoleTools('coder')).toEqual(['bug_report', 'files.references_list', 'files.reference_read', 'context_get', 'interaction_list', 'interaction_get', ...outputs, 'ci_run', 'ci_get',
      'ci_computers_list', 'ci_cancel', 'ci_logs_read'])
    expect(effectiveForemanTools('coder')).toEqual(['bug_report', 'files.references_list', 'files.reference_read', 'context_get', 'interaction_list', 'interaction_get', ...outputs, 'ci_run', 'ci_get',
      'ci_computers_list', 'ci_cancel', 'ci_logs_read'])
    expect(effectiveForemanTools('coder', ['context_get'])).toEqual(['bug_report', 'context_get'])
    expect(effectiveForemanTools('coder', ['context_get'], { add: ['interaction_get'], remove: ['context_get'] }))
      .toEqual(['bug_report', 'interaction_get'])
    expect(effectiveForemanTools('coder', [], { add: ['interaction_respond'], remove: [] })).toEqual(['bug_report'])
    expect(effectiveForemanTools('orchestrator', [], { add: ['interaction_respond'], remove: [] }))
      .toEqual(['bug_report', 'interaction_respond'])
    expect(foremanToolRoles('interaction_respond')).toEqual(['operator', 'master', 'orchestrator'])
  })
  it('keeps workflow output settings within Agent roles and honors explicit defaults and node removals', () => {
    const outputs = Object.values(WORKER_NATIVE_OUTPUT_TOOL_NAMES)
    for (const tool of outputs) {
      expect(foremanToolRoles(tool)).toEqual(['master', 'orchestrator', 'coder'])
      expect(ForemanToolOverrideSchema.parse({ add: [tool], remove: [] }).add).toEqual([tool])
      expect(effectiveForemanTools('coder', ['context_get'], { add: [tool], remove: [] }))
        .toEqual(['bug_report', 'context_get', tool])
    }
    expect(effectiveForemanTools('coder', outputs, { add: [], remove: outputs })).toEqual(['bug_report'])
  })

  it('keeps reference reads within Agent roles and honors their defaults and node removals', () => {
    const references = ['files.references_list', 'files.reference_read'] as const
    for (const tool of references) {
      expect(foremanToolRoles(tool)).toEqual(['master', 'orchestrator', 'coder'])
      expect(effectiveForemanTools('coder', [], { add: [tool], remove: [] })).toEqual(['bug_report', tool])
    }
    expect(effectiveForemanTools('coder', [...references], { add: [], remove: [...references] })).toEqual(['bug_report'])
  })

  it('enables Run status only on nodes with interval checks, never from Agent defaults or node tool changes', () => {
    for (const role of ['coder', 'orchestrator'] as const) {
      expect(foremanRoleTools(role)).not.toContain('run_status_get')
      expect(effectiveForemanTools(role)).not.toContain('run_status_get')
      expect(effectiveForemanTools(role, ['run_status_get'], { add: ['run_status_get'], remove: [] })).not.toContain('run_status_get')
      expect(effectiveForemanTools(role, ['context_get'], undefined, true)).toEqual(['bug_report', 'context_get', 'run_status_get'])
    }
  })

  it('keeps bug reporting available for existing explicit defaults and node removals', () => {
    for (const role of ['coder', 'orchestrator'] as const) {
      expect(effectiveForemanTools(role, [], { add: [], remove: ['bug_report'] })).toEqual(['bug_report'])
    }
    expect(foremanToolRoles('bug_report')).toEqual(['operator', 'master', 'orchestrator', 'coder'])
  })

  it('accepts only known Agent tools, without overlap', () => {
    expect(ForemanToolDefaultsSchema.safeParse(['workflow_create']).success).toBe(false)
    expect(AgentSchema.shape.graphqlTools.safeParse(['context_get', 'context_get']).success).toBe(false)
    expect(ForemanToolOverrideSchema.safeParse({ add: ['context_get'], remove: ['context_get'] }).success).toBe(false)
    expect(CurrentWorkflowNodeSchema.safeParse({ id: 'n', agentId: 'a', name: 'N', graphqlTools: { add: ['interaction_get'], remove: [] } }).success).toBe(true)
  })

  it('rejects removed group tools in Agent settings and the Operator catalog', () => {
    for (const name of ['workflow_chat_read', 'workflow_chat_post', 'workflow_chat_deliveries_read', 'workflow_chat_delivery_cancel']) {
      expect(ForemanToolDefaultsSchema.safeParse([name]).success).toBe(false)
      expect(AgentCreateInputSchema.shape.graphqlTools.safeParse([name]).success).toBe(false)
      expect(AgentUpdateInputSchema.shape.graphqlTools.safeParse([name]).success).toBe(false)
      expect(ForemanToolOverrideSchema.safeParse({ add: [name], remove: [] }).success).toBe(false)
      expect(OperatorToolNameSchema.safeParse(name).success).toBe(false)
    }
    for (const name of ['agent_chat_read', 'agent_chat_send', 'operator_chat_send']) {
      expect(OperatorToolNameSchema.parse(name)).toBe(name)
    }
  })

  it('filters retired recorded choices for execution and newly authored values', () => {
    const defaults = ['workflow_chat_post', 'context_get']
    const override = { add: ['workflow_chat_read', 'interaction_get'], remove: ['workflow_chat_post'] }
    expect(activeForemanTools(defaults)).toEqual(['context_get'])
    expect(activeForemanToolOverride(override)).toEqual({ add: ['interaction_get'], remove: [] })
    expect(effectiveForemanTools('coder', defaults, override, false, ['workflow_chat_read', 'workflow_chat_post']))
      .toEqual(['bug_report', 'context_get', 'interaction_get'])
    expect(defaults).toEqual(['workflow_chat_post', 'context_get'])
    expect(override).toEqual({ add: ['workflow_chat_read', 'interaction_get'], remove: ['workflow_chat_post'] })
  })

  it('executes exact saved workflow facts with retired tool metadata while enforcing active tool roles', () => {
    const f = makeCurrentWorkflowFixture('retired-tools-execution', 'single')
    const saved = { version: { ...f.version, definition: { ...f.version.definition,
      nodes: f.version.definition.nodes.map(node => ({ ...node,
        graphqlTools: { add: ['workflow_chat_read', 'context_get'], remove: ['workflow_chat_post'] },
      })),
    } }, configurations: f.configurations.map(configuration => ({ ...configuration,
      graphqlTools: ['workflow_chat_post', 'context_get'],
    })) }
    const original = structuredClone(saved)
    expect(ExecutableWorkflowCurrentSchema.parse(saved)).toEqual(original)
    expect(saved).toEqual(original)
    const denied = ExecutableWorkflowCurrentSchema.safeParse({ ...saved, version: { ...saved.version,
      definition: { ...saved.version.definition, nodes: saved.version.definition.nodes.map(node => ({ ...node,
        graphqlTools: { add: ['interaction_respond'], remove: [] },
      })) },
    } })
    expect(denied.success).toBe(false)
    if (!denied.success) expect(denied.error.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ message: expect.stringContaining('outside its Agent role') }),
    ]))
  })

  it('rejects retired node tools when creating or saving a workflow', () => {
    const f = makeCurrentWorkflowFixture('retired-tools-authoring', 'single')
    const graph = { ...f.version.definition, nodes: f.version.definition.nodes.map(node => ({ ...node,
      graphqlTools: { add: ['workflow_chat_read'], remove: ['workflow_chat_post'] },
    })) }
    const save = { workspaceId: f.scope.workspaceId, workflowId: f.scope.workflowId, executionSemanticsVersion: 3,
      expectedRevision: 1, expectedWorkflowVersionId: f.version.id,
      expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds, graph }
    expect(CurrentWorkflowSaveInputSchema.safeParse(save).success).toBe(false)
    const activeNodes = graph.nodes.map(node => ({ ...node, graphqlTools: activeForemanToolOverride(node.graphqlTools) }))
    expect(CurrentWorkflowSaveInputSchema.safeParse({ ...save, graph: { ...graph, nodes: activeNodes } }).success).toBe(true)
    const { id: _id, workspaceId: _workspaceId, name: _name, version: _version, ...initialGraph } = graph
    void _id; void _workspaceId; void _name; void _version
    const create = { workspaceId: f.scope.workspaceId, name: 'New workflow', initialSave: { graph: initialGraph,
      expectedAgentConfigurationVersionIds: f.version.agentConfigurationVersionIds } }
    expect(CurrentWorkflowCreateInputSchema.safeParse(create).success).toBe(false)
    expect(CurrentWorkflowCreateInputSchema.safeParse({ ...create, initialSave: { ...create.initialSave,
      graph: { ...initialGraph, nodes: activeNodes } } }).success).toBe(true)
  })
})

it('requires both grants for protected root adoption and keeps it out of Agent tools', () => {
  const name = 'workspace_root_configuration_adopt', tool = FOREMAN_OPERATOR_TOOLS[name]
  expect(OperatorToolNameSchema.parse(name)).toBe(name)
  expect(tool.actions).toEqual(['source_roots:bind', 'workspace_locations:update'])
  expect(tool.scope).toBe('workspace')
  expect(tool.readOnly).toBe(false)
  expect(foremanToolRoles(name)).toEqual(['operator'])
  expect(ForemanToolDefaultsSchema.safeParse([name]).success).toBe(false)
  expect(ForemanToolOverrideSchema.safeParse({ add: [name], remove: [] }).success).toBe(false)
})

it('round-trips saved Agent and workflow tool fields under their original names', () => {
  const agent = { id: 'saved-agent', name: 'Saved Agent', graphqlTools: ['context_get'] }
  const node = { id: 'saved-node', name: 'Saved Node', agentId: agent.id, graphqlTools: { add: ['interaction_get'], remove: [] } }
  expect(JSON.parse(JSON.stringify(AgentSchema.parse(agent)))).toEqual(agent)
  expect(JSON.parse(JSON.stringify(CurrentWorkflowNodeSchema.parse(node)))).toEqual(node)
  expect(AgentSchema.safeParse({ ...agent, foremanTools: [] }).success).toBe(false)
  expect(CurrentWorkflowNodeSchema.safeParse({ ...node, foremanTools: { add: [], remove: [] } }).success).toBe(false)
})

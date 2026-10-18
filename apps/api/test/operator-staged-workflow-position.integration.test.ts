import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import {
  CurrentEditReadResultSchema, CurrentWorkflowReadResultSchema, SavedManagedWorkflowSchema,
} from '@foreman-code/contracts/wave25'
import { graphRpcValue } from './eng04-graph-composition-fixture.js'
import { useWorkflowManagementFixture } from './workflowManagement.helpers.js'

const context = useWorkflowManagementFixture()

it.each(['new node', 'retained node'] as const)(
  'publishes staged Agent changes with unmarked coordinates for a %s', async (scenario) => {
    const f = await context.fixture('single')
    f.input.graph.nodes = f.input.graph.nodes.map(node => ({ ...node, position: { x: 10, y: 20 } }))
    const first = await context.save(f)
    const stage = await context.agentStage(f, first)
    const nodeId = scenario === 'new node' ? 'added-worker' : stage.graph.nodes[0]!.id
    stage.graph = { ...stage.graph, entryNodeId: nodeId,
      nodes: stage.graph.nodes.map(node => ({ ...node, id: nodeId, position: { x: 100, y: 200 } })) }
    const call = async (name: string, args: unknown) => {
      const reply = await f.call(name, args)
      expect(reply.result?.isError, JSON.stringify(reply)).not.toBe(true)
      return graphRpcValue(reply.result)
    }
    const staged = CurrentEditReadResultSchema.parse(await call('workflow_edit_v3', stage)).intent!
    const advance = { workspaceId: stage.workspaceId, workflowId: stage.workflowId,
      draftId: stage.draftId, intentId: staged.id, action: 'stop_and_save', commandId: staged.advanceCommandId }
    const completed = CurrentEditReadResultSchema.parse(await call('workflow_edit_v3', advance))
    expect(completed.intent?.state, JSON.stringify(completed.intent?.error)).toBe('saved')
    expect(completed.intent?.saveInput).toEqual(staged.saveInput)
    expect(completed.intent?.saveInputHash).toBe(staged.saveInputHash)
    expect(completed.intent?.saveInput.graph.nodes[0]?.position).toEqual({ x: 100, y: 200, manual: true })
    expect(completed.intent?.result?.agents?.[0]?.agent.prompt.system).toBe('Use the staged instructions.')
    expect(await call('workflow_edit_v3', advance)).toEqual(completed)
    const scope = { workspaceId: stage.workspaceId, workflowId: stage.workflowId }
    const saved = CurrentWorkflowReadResultSchema.parse(await call('workflow_saved_get_v3', scope))
    expect(saved.version).toEqual(completed.intent!.result!.version)
    const expectedPosition = scenario === 'new node' ? { x: 100, y: 200, manual: true } : { x: 10, y: 20 }
    expect(saved.version.definition.nodes[0]?.position).toEqual(expectedPosition)
    expect(SavedManagedWorkflowSchema.parse(await call('workflow_get', scope)).workflow.nodes[0]?.position)
      .toEqual(expectedPosition)
    expect(await context.count(f, 'workflow_versions')).toBe(2)
  },
)

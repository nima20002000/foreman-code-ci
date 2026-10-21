import { describe, expect, it } from 'vitest'
import { AgentConfigurationVersionSchema } from '@foreman-code/contracts'
import { WorkActivationInputSchema } from '@foreman-code/contracts/wave25'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { hierarchyRuntimeFixture, coordinationOutput } from './helpers/hierarchyRuntimeFixture.js'
import { ControlledWorkflowProvider } from './helpers/controlledWorkflowProvider.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('hierarchy expanded feedback reservation', () => {
  it('refuses the entire oversized batch before admitting or starting any child', async () => {
    const fixture = hierarchyRuntimeFixture({ maximum: 21 })
    fixture.run.input = { task: 'x'.repeat(3.5 * 1024 * 1024) }
    const workers = Array.from({ length: 16 }, (_, index) => `worker_${index}`)
    const names = ['master', 'build', ...workers]
    const templates = [fixture.configurations[0]!, fixture.configurations[1]!]
    const worker = fixture.configurations[4]!
    fixture.configurations = names.map((name, index) => AgentConfigurationVersionSchema.parse({
      ...(templates[index] ?? worker), id: `configuration-${name}`, agentId: `agent-${name}`,
    }))
    const edges = [{ id: 'master-build', kind: 'execution' as const, source: 'master', target: 'build' },
      ...workers.map(name => ({ id: `build-${name}`, kind: 'execution' as const, source: 'build', target: name }))]
    fixture.version.agentConfigurationVersionIds = Object.fromEntries(fixture.configurations.map(value => [value.agentId, value.id]))
    fixture.version.definition = { ...fixture.version.definition,
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 21 }, edges,
      nodes: names.map((name, index) => ({ id: name, agentId: fixture.configurations[index]!.agentId, name,
        ...(index < 2 ? { choice: { outcomes: edges.filter(edge => edge.source === name).map(edge => ({
          outcome: edge.target, target: { kind: 'edge' as const, relationshipId: edge.id },
        })) } } : {}) })),
      hierarchy: { version: 1, masterNodeId: 'master', parents: edges.map(edge => ({
        workflowNodeId: edge.target, parentNodeId: edge.source,
      })) },
    }
    const provider = new ControlledWorkflowProvider(workers, (node, request) => {
      const input = WorkActivationInputSchema.parse(request.input)
      const selected = node === 'master' ? ['build'] : workers
      if ((node === 'master' || node === 'build') && input.work.kind !== 'hierarchy_group') {
        return { routing: { kind: 'delegate', requests: selected.map(outcome => ({ outcome, data: { task: outcome } })) },
          data: { latestDeliverable: 'Plan', remainingFindings: [] }, summary: 'Delegate work', board: { kind: 'none', reason: 'no_changes' } }
      }
      return coordinationOutput(node, request, { select: [] })
    })
    const f = await currentOperatorIntegration({ fixture, approvalNodeIds: [], collaborationPorts: {},
      managerFactory: context => provider.connection(context) })
    const drive = f.engine.start(f.f.run.id).catch(error => error)
    try {
      await expect.poll(async () => (await f.db.pool.query('select code from run_hierarchy_refusals where run_id=$1',
        [f.f.run.id])).rows, { timeout: 15_000 }).toEqual([{ code: 'HIERARCHY_INPUT_TOO_LARGE' }])
      expect((await f.runs.listRepeatExecutions(f.f.run.id)).some(row => workers.includes(row.execution.workflowNodeId))).toBe(false)
      expect((await f.db.pool.query('select destination_node_id from run_work_requests where run_id=$1',
        [f.f.run.id])).rows).toEqual([{ destination_node_id: 'build' }])
      expect(provider.maximumActive).toBe(0)
    } finally { provider.releaseAll(); await f.stop(); await drive; await f.close() }
  }, 60_000)
})

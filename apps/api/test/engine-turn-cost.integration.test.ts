import pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { WorkActivationInputSchema } from '@foreman-code/contracts/current'
import { runtimeTimingChannel, type RuntimeTimingRecord } from '../src/infrastructure/runtimeTiming.js'
import { checkpointRuntimeFixture } from './helpers/checkpointRuntime.js'
import { hierarchyRuntimeFixture, receivedRequest } from './helpers/hierarchyRuntimeFixture.js'

afterEach(() => vi.restoreAllMocks())

it.each([0, 60 * 1024])('bounds engine work for sixteen serial fake children with %i output bytes', async bytes => {
  const children = 16
  const saved = hierarchyRuntimeFixture({ maximum: children * 2 + 1 })
  saved.configurations = saved.configurations.slice(0, 2)
  saved.version.agentConfigurationVersionIds = Object.fromEntries(saved.configurations.map(c => [c.agentId, c.id]))
  saved.version.definition.nodes = saved.version.definition.nodes.slice(0, 2).map(node => node.id === 'master'
    ? { ...node, choice: { outcomes: [{ outcome: 'build', target: { kind: 'edge', relationshipId: 'route-master-build' } }] } }
    : { id: node.id, agentId: node.agentId, name: node.name })
  saved.version.definition.edges = [{ id: 'route-master-build', kind: 'execution', source: 'master', target: 'build' }]
  saved.version.definition.hierarchy!.parents = [{ workflowNodeId: 'build', parentNodeId: 'master' }]
  saved.version.definition.executionPolicy!.maxParallelism = 1
  saved.run.agentConfigurationVersionIds = saved.version.agentConfigurationVersionIds
  const output = 'x'.repeat(bytes)
  let delegated = 0
  const seen: unknown[] = []
  const f = await checkpointRuntimeFixture(1, 1, { fixture: saved, approvalNodeIds: [], collaborationPorts: {},
    outputFor: (nodeId, request) => {
      const input = WorkActivationInputSchema.parse(request.input)
      if (nodeId === 'master') {
        if (input.work.kind === 'hierarchy_group') seen.push(...input.work.returns.map(item => item.latestDeliverable))
        const routing = delegated++ < children
          ? { kind: 'delegate', requests: [{ outcome: 'build', data: { task: 'Return the next numbered result' } }] }
          : { kind: 'finish' }
        return { routing, data: { latestDeliverable: 'Master summary', remainingFindings: [] },
          summary: 'Serial delegation', board: { kind: 'none', reason: 'no_access' } }
      }
      return { routing: { kind: 'return', requestId: receivedRequest(input), outcome: 'accepted' },
        data: { latestDeliverable: { ordinal: delegated, output }, remainingFindings: [] },
        summary: 'Child completed', board: { kind: 'none', reason: 'no_access' } }
    } })
  const phases = new Map<string, { count: number; ms: number }>()
  const statements = new Map<string, { count: number; ms: number }>()
  const observe = (message: unknown) => {
    const record = message as RuntimeTimingRecord
    const value = phases.get(record.phase) ?? { count: 0, ms: 0 }
    value.count++; value.ms += record.durationMs; phases.set(record.phase, value)
    if (record.statementId) {
      const statement = statements.get(record.statementId) ?? { count: 0, ms: 0 }
      statement.count++; statement.ms += record.durationMs; statements.set(record.statementId, statement)
    }
  }
  runtimeTimingChannel.subscribe(observe)
  const queries = vi.spyOn(pg.Client.prototype, 'query')
  try {
    const start = performance.now()
    await f.engine.start(f.f.run.id)
    const elapsedMs = performance.now() - start
    const statementCount = queries.mock.calls.length
    queries.mockRestore()
    runtimeTimingChannel.unsubscribe(observe)
    console.info('engine-turn-cost', JSON.stringify({ bytes, turns: children * 2 + 1, elapsedMs, statementCount,
      phases: Object.fromEntries(phases), statements: [...statements].sort((a, b) => b[1].ms - a[1].ms).slice(0, 12) }))
    expect(await f.runs.get(f.f.run.id)).toMatchObject({ executionSemanticsVersion: 3,
      executionState: 'completed', outcome: 'succeeded' })
    expect(f.provider.counts.starts).toBe(children * 2 + 1)
    expect(seen).toEqual(Array.from({ length: children }, (_, index) => ({ ordinal: index + 1, output })))
    const executions = (await f.runs.listRepeatExecutions(f.f.run.id)).map(item => item.execution)
    expect(executions).toHaveLength(children * 2 + 1)
    expect(executions.every(execution => execution.state === 'completed' && execution.result?.outcome === 'succeeded')).toBe(true)
    expect(statementCount).toBeLessThanOrEqual((children * 2 + 1) * 1_000)
  } finally {
    queries.mockRestore()
    runtimeTimingChannel.unsubscribe(observe)
    await f.close()
  }
}, 180_000)

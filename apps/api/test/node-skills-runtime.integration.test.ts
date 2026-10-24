import { createHash, randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import type { ResolvedSkill } from '@foreman-code/contracts'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/current'
import { codexApprovalRuntime } from './helpers/codexApprovalRuntime.js'
import { deferred } from './helpers/deferred.js'
import { readUntil } from './helpers/observableCondition.js'
import { runtimeTimingChannel, type RuntimeTimingRecord } from '../src/infrastructure/runtimeTiming.js'

it('delivers independent node skill additions and removals to concurrent native sessions and recovers them', async () => {
  const f = makeCurrentWorkflowFixture(randomUUID(), 'parallel')
  const makeSkill = (skillId: string, instructions: string): ResolvedSkill => ({ skillId, version: '1', instructions,
    contentHash: `sha256:${createHash('sha256').update(instructions).digest('hex')}` })
  const skills = [makeSkill('common', 'Shared instructions.'), makeSkill('base', 'Base instructions.'),
    makeSkill('left', 'Left instructions.'), makeSkill('right', 'Right instructions.')]
  const reference = (index: number) => ({ skillId: skills[index]!.skillId, version: '1' })
  const configuration = f.configurations[0]!
  configuration.instructionDelivery = 'native-v1'
  configuration.assignedSkills = [reference(0), reference(1)]
  configuration.resolvedSkills = skills.slice(0, 2)
  f.configurations = [configuration]
  f.version.agentConfigurationVersionIds = { [configuration.agentId]: configuration.id }
  for (const node of f.version.definition.nodes) node.agentId = configuration.agentId
  const [entry, left, right] = f.version.definition.nodes
  expect([entry, left, right]).not.toContain(undefined)
  left!.skills = { remove: ['base'], add: [reference(2)] }
  right!.skills = { remove: ['common'], add: [reference(3)] }
  const finish = deferred()
  const instructions = new Map<string, string>()
  const startedAt = performance.now()
  const events: string[] = []
  const mark = (label: string) => events.push(`${Math.round(performance.now() - startedAt)} ${label}`)
  const onTiming = (message: unknown) => { const r = message as RuntimeTimingRecord
    if (r.durationMs > 50 || /start|admit|acquire|launch|session/.test(r.phase)) mark(`timing ${r.component}.${r.phase} ${Math.round(r.durationMs)}ms ${r.executionId ?? ''}`) }
  runtimeTimingChannel.subscribe(onTiming)
  const states = new Map<string, string>()
  const fixture = await codexApprovalRuntime('user', { fixture: f, skills, approvalPolicy: 'never',
    onRequest(executionId, method, params) {
      mark(`request ${executionId.slice(-6)} ${method}`)
      if (method === 'thread/start') instructions.set(executionId, String(params?.developerInstructions))
    },
    workflowOutput: async executionId => {
      const execution = await fixture.runs.getExecution(executionId)
      mark(`turn ${execution?.workflowNodeId}`)
      if (execution?.workflowNodeId !== entry!.id) await finish.promise
      return 'Done'
    },
  })
  mark('fixture ready')
  let runtime: ReturnType<typeof fixture.compose> = fixture
  const started = Promise.allSettled([runtime.engine.start(f.run.id)])
  const branchExecutions = () => fixture.db.pool.query<{ id: string; node: string; state: string; attempt: number }>(
    `select id,workflow_node_id as node,record->>'state' as state,attempt from harness_executions
      where run_id=$1 and workflow_node_id=any($2::text[]) order by workflow_node_id`,
    [f.run.id, [left!.id, right!.id]])
  try {
    const branches = await readUntil(async () => {
      const rows = (await branchExecutions()).rows
      const all = (await fixture.db.pool.query<{ id: string; node: string; state: string }>(`select id,workflow_node_id as node,record->>'state' as state from harness_executions where run_id=$1`, [f.run.id])).rows
      for (const row of all) if (states.get(row.id) !== row.state) { states.set(row.id, row.state); mark(`row ${row.node} ${row.id.slice(-6)} ${row.state}`) }
      for (const row of rows) {
        const execution = await runtime.runs.getExecution(row.id)
        expect(execution?.result?.outcome, 'Node skill overrides must reach native execution without startup failure')
          .not.toBe('failed')
      }
      return rows
    },
      rows => rows.length === 2 && rows.every(row => row.state === 'running' && instructions.has(row.id)),
      { timeoutMs: 10_000, description: 'both native branches running' })
    const leftId = branches.find(row => row.node === left!.id)!.id
    mark('both running')
    const rightId = branches.find(row => row.node === right!.id)!.id
    expect(instructions.get(leftId)).toContain('Shared instructions.')
    expect(instructions.get(leftId)).toContain('Left instructions.')
    expect(instructions.get(leftId)).not.toContain('Base instructions.')
    expect(instructions.get(leftId)).not.toContain('Right instructions.')
    expect(instructions.get(rightId)).toContain('Base instructions.')
    expect(instructions.get(rightId)).toContain('Right instructions.')
    expect(instructions.get(rightId)).not.toContain('Shared instructions.')
    expect(instructions.get(rightId)).not.toContain('Left instructions.')
    await runtime.engine.shutdown()
    await started
    runtime = fixture.compose()
    await runtime.engine.reconcile(error => { throw error })
    // The replay transport has no detached process; restart retries these interrupted native attempts.
    const retries = await readUntil(async () => (await branchExecutions()).rows.filter(row => row.attempt === 2),
      rows => rows.length === 2 && rows.every(row => row.state === 'running' && instructions.has(row.id)),
      { timeoutMs: 10_000, description: 'both recovered native branches running' })
    for (const branch of branches) {
      expect(await runtime.runs.getExecution(branch.id)).toMatchObject({ state: 'completed',
        result: { outcome: 'failed', error: { code: 'EXECUTION_INTERRUPTED', retryable: true } } })
      const retry = retries.find(row => row.node === branch.node)!
      expect(instructions.get(retry.id)).toBe(instructions.get(branch.id))
    }
    expect(instructions.size).toBe(5)
    finish.resolve()
    const completed = await readUntil(() => runtime.runs.get(f.run.id), run => run?.executionState === 'completed',
      { timeoutMs: 10_000, description: 'recovered workflow completion' })
    expect(completed?.outcome).toBe('succeeded')
    expect((await branchExecutions()).rows).toEqual(expect.arrayContaining(
      [...branches, ...retries].map(row => ({ ...row, state: 'completed' }))))
    for (const retry of retries) {
      expect((await runtime.runs.getExecution(retry.id))?.result?.outcome).toBe('succeeded')
    }
    expect((await runtime.workflows.getAgentConfiguration(configuration.id))?.assignedSkills)
      .toEqual([reference(0), reference(1)])
    mark('end')
    throw new Error(`PROBE\n${events.join('\n')}`)
  } catch (error) {
    mark(`error ${String(error).slice(0, 80)}`)
    throw new Error(`PROBE\n${events.join('\n')}`)
  } finally {
    runtimeTimingChannel.unsubscribe(onTiming)
    finish.resolve()
    await fixture.stop()
    await runtime.engine.cancel(f.run.id)
    await fixture.close()
    await started
  }
}, 60_000)

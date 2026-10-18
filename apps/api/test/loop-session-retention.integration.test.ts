import { randomUUID } from 'node:crypto'
import { readFile, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { DEFAULT_CODEX_ADVANCED_CONFIGURATION } from '@foreman-code/contracts'
import { CurrentWorkflowSaveResultSchema, RunStartV3ResultSchema, SavedRunDetailsSchema,
  makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { sourceWorktreeMcpFixture } from './helpers/sourceWorktreeMcpFixture.js'
import { readUntil } from './helpers/observableCondition.js'
import { postgresEnabled } from './helpers/eng04CurrentDatabase.js'

describe.runIf(postgresEnabled)('loop node directory and native session retention through MCP', () => {
  it.each([false, true])('retains only inherited node checkouts across serialized loop turns (placed=%s)', async placed => {
    const fixture = makeCurrentWorkflowFixture(randomUUID(), 'sequential')
    fixture.version.approval = { handler: 'native' }
    fixture.version.definition.approval = { handler: 'native' }
    fixture.run.approval = { handler: 'native' }
    for (const [index, configuration] of fixture.configurations.entries()) {
      if (configuration.harness.harness !== 'codex') throw new Error('Expected Codex')
      configuration.harness.sandbox = 'read-only'
      configuration.harness.model = index === 0 ? 'loop-model' : 'worker-model'
      configuration.harness.advanced = { ...DEFAULT_CODEX_ADVANCED_CONFIGURATION, approvalPolicy: 'never' }
    }
    const f = await sourceWorktreeMcpFixture({ approvalNodeIds: [], fixture })
    try {
      const graph = structuredClone(f.saved.version.definition)
      graph.approval = { handler: 'native' }
      graph.defaultWorktree = { rootBinding: { rootId: f.root.binding.rootId,
        bindingRevision: f.root.binding.bindingRevision } }
      const node = graph.nodes[0]!
      if (node.kind === 'job') throw new Error('Expected an Agent')
      node.interval = { everySeconds: 10, prompt: 'Check this Run and remember earlier findings.' }
      if (!placed) delete node.placement
      const response = await f.client.callTool({ name: 'workflow_save_v3', arguments: {
        workspaceId: f.input.workspaceId, workflowId: f.input.workflowId, graph,
        executionSemanticsVersion: 3, expectedRevision: f.saved.revision,
        expectedWorkflowVersionId: f.saved.currentVersionId,
        expectedAgentConfigurationVersionIds: f.saved.version.agentConfigurationVersionIds,
      } })
      expect(response.isError, JSON.stringify(response)).not.toBe(true)
      const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(response)).value
      const started = await f.client.callTool({ name: 'run_start', arguments: {
        ...f.input, workflowVersionId: saved.currentVersionId, expectedWorkflowRevision: saved.revision,
      } })
      expect(started.isError, JSON.stringify(started)).not.toBe(true)
      const runId = RunStartV3ResultSchema.parse(decodeMcpToolResult(started)).run.id
      const scope = { workspaceId: f.input.workspaceId, runId }
      const read = async () => {
        const result = await f.client.callTool({ name: 'run_get', arguments: { ...scope, detail: 'full' } })
        expect(result.isError, JSON.stringify(result)).not.toBe(true)
        return SavedRunDetailsSchema.parse(decodeMcpToolResult(result))
      }
      const turns = (details: Awaited<ReturnType<typeof read>>) => details.executions
        .filter(execution => execution.workflowNodeId === node.id)
        .sort((left, right) => left.createdAt.localeCompare(right.createdAt))
      const initial = await readUntil(read, details => turns(details).some(turn => turn.state === 'completed'),
        { timeoutMs: 30_000, description: 'initial node completion' })
      const first = turns(initial)[0]!
      expect(first.nativeSessionId).toBeDefined()
      const retainedFile = join(first.workingDirectory!, 'monitoring-notes.txt')
      await writeFile(retainedFile, 'Already reported the deployment failure.\n')
      const checked = await readUntil(read, details => turns(details).filter(turn => turn.state === 'completed').length >= 3,
        { timeoutMs: 40_000, description: 'two completed loop turns' })
      const executions = turns(checked).filter(turn => turn.state === 'completed')
      const [original, ...loops] = executions
      expect(loops).toHaveLength(2)
      expect(loops.map(loop => loop.input)).toEqual([1, 2].map(index => expect.objectContaining({
        tick: { index, everySeconds: 10 } })))
      if (placed) {
        expect(new Set(executions.map(turn => turn.workingDirectory)).size).toBe(3)
        expect(new Set(executions.map(turn => turn.nativeSessionId)).size).toBe(3)
        expect(loops.every(loop => loop.sessionContinuation === undefined)).toBe(true)
      } else {
        expect(new Set(executions.map(turn => turn.workingDirectory)).size).toBe(1)
        expect(loops.map(loop => loop.nativeSessionId)).toEqual([original!.nativeSessionId, original!.nativeSessionId])
        expect(loops.map(loop => loop.sessionContinuation?.previousExecutionId))
          .toEqual([original!.id, loops[0]!.id])
        expect(await readFile(retainedFile, 'utf8')).toBe('Already reported the deployment failure.\n')
      }
      for (let index = 1; index < executions.length; index++) {
        expect(Date.parse(executions[index]!.startedAt!)).toBeGreaterThanOrEqual(
          Date.parse(executions[index - 1]!.finishedAt!))
      }
      expect(checked.executions.filter(execution => execution.workflowNodeId !== node.id)).toHaveLength(1)
      expect(checked.run.executionState).toBe('running')
      expect(f.base.dispatchErrors).toEqual([])
      const denied = await f.base.access.issue({ name: 'Denied loop reader', audience: 'operator',
        expiresAt: new Date(Date.now() + 600_000), grants: [] })
      expect((await (await f.connect(denied.token)).callTool({ name: 'run_get', arguments: scope })).isError).toBe(true)
      const stopped = await f.client.callTool({ name: 'run_stop', arguments: scope })
      expect(stopped.isError).not.toBe(true)
      const finished = await readUntil(read, details => details.run.executionState === 'completed',
        { timeoutMs: 10_000, description: 'loop Run stopped' })
      expect(finished.run.outcome).toBe('canceled')
      await f.base.engine.reconcile(error => { throw error })
      expect((await read()).executions).toHaveLength(finished.executions.length)
      expect(finished.executions.every(execution => execution.state === 'completed')).toBe(true)
    } finally { await f.close() }
  }, 120_000)
})

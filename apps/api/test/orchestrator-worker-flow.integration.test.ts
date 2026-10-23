import assert from 'node:assert/strict'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionResult } from '@foreman-code/contracts'
import { WorkActivationInputSchema, type WorkActivationInput, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'
import { hasWorkDirectionWait } from '../src/modules/runs/workflowLifecycle.js'
import { RunHandoffReadService } from '../src/modules/runs/handoffRead.js'
import { handoffs, runtime, timeout, useSettlementFixtures } from './helpers/workflowSettlementTestSupport.js'

// Native terminals are scripted per execution; typed Save, the engine, routing, SQL constraints and settlement execute.
vi.mock('../src/modules/interactions/repeatNativeSettlement.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  settleRepeatNativeExecutionLocked: vi.fn(async () => undefined),
  settleRepeatNativeExecutionWithProofLocked: vi.fn(async () => undefined),
}))

const result = (routing: Record<string, unknown>, latestDeliverable: unknown, remainingFindings: unknown[] = []): ExecutionResult =>
  ({ outcome: 'succeeded', output: { routing, data: { latestDeliverable, remainingFindings } } }) as ExecutionResult

/** The owner's saved shape: an Orchestrator connected to one Worker, no named routes, no hierarchy. */
const team = (graph: WorkflowDefinitionV3): WorkflowDefinitionV3 => ({ ...handoffs(10)(graph),
  nodes: graph.nodes.map((node, index) => ({ ...node, name: index === 0 ? 'Orchestrator' : 'Worker' })) })

describe.skipIf(process.env.NIM2691_POSTGRES !== '1')('Orchestrator and Worker workflow', () => {
  const withFixture = useSettlementFixtures()

  it('starts the Worker with the Orchestrator task and brings each Worker result back to the Orchestrator to check', async () => {
    await withFixture(team, async (f) => {
      const [orchestrator, worker] = f.version.definition.nodes.map((node) => node.id)
      const seen: Array<{ nodeId: string; work: WorkActivationInput['work'] }> = []
      const replies: ExecutionResult[] = [
        result({ kind: 'finish' }, { task: 'Open google.com and take a screenshot' }),
        result({ kind: 'finish' }, { screenshot: 'viewport.png' }),
        result({ kind: 'return', outcome: 'needs_changes' }, { fix: 'Capture the full page' }),
        result({ kind: 'finish' }, { screenshot: 'full-page.png' }),
        result({ kind: 'return', outcome: 'accepted' }, { approved: 'full-page.png' }),
      ]
      await runtime(f, async (execution) => {
        if (execution.state === 'completed') return
        seen.push({ nodeId: execution.workflowNodeId, work: WorkActivationInputSchema.parse(execution.input).work })
        const reply = replies[seen.length - 1]
        assert.ok(reply, `unexpected execution ${seen.length} on ${execution.workflowNodeId}`)
        await f.finish(execution.id, reply)
      })()
      expect(seen.map((item) => [item.nodeId, item.work.kind])).toEqual([
        [orchestrator, 'entry'], [worker, 'work_request'], [orchestrator, 'work_request'],
        [worker, 'work_return'], [orchestrator, 'work_request'],
      ])
      const [, task, review, rework, final] = seen.map((item) => item.work)
      assert.ok(task?.kind === 'work_request' && review?.kind === 'work_request'
        && rework?.kind === 'work_return' && final?.kind === 'work_request')
      expect(task.acceptedSourceResult).toMatchObject({ output: { data: { latestDeliverable: { task: 'Open google.com and take a screenshot' } } } })
      expect(review.request).toMatchObject({ requesterNodeId: worker, destinationNodeId: orchestrator })
      expect(review.acceptedSourceResult).toMatchObject({ output: { data: { latestDeliverable: { screenshot: 'viewport.png' } } } })
      expect(rework.returned).toMatchObject({ outcome: 'needs_changes', latestDeliverable: { fix: 'Capture the full page' } })
      expect(final.acceptedSourceResult).toMatchObject({ output: { data: { latestDeliverable: { screenshot: 'full-page.png' } } } })
      expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
      // The Run's hand-offs, in order, so the Board can show each one crossing the line between the two Agents.
      const read = await new RunHandoffReadService(f.db.pool).read(f.writer.principal, { workspaceId: f.scope.workspaceId, runId: f.run.id })
      expect(read.transfers.map((item) => [item.kind, item.fromNodeId, item.toNodeId, item.outcome ?? null])).toEqual([
        ['request', orchestrator, worker, null], ['request', worker, orchestrator, null],
        ['return', orchestrator, worker, 'needs_changes'], ['request', worker, orchestrator, null],
        ['return', orchestrator, worker, 'accepted'],
      ])
      expect(read.transfers.every((item) => item.relationshipId === f.version.definition.edges[0]!.id)).toBe(true)
      expect(read.transfers.slice(0, 4).every((item) => item.toActivationId)).toBe(true)
    }, 'sequential', { roles: ['orchestrator', 'coder'] })
  }, timeout)

  it('sends every Worker result back even when the connection allows only one handoff', async () => {
    const once = (graph: WorkflowDefinitionV3): WorkflowDefinitionV3 => {
      const shaped = team(graph)
      return { ...shaped, edges: shaped.edges.map((edge) => ({ ...edge, maxWorkHandoffsPerRun: 1 })) }
    }
    await withFixture(once, async (f) => {
      const [orchestrator, worker] = f.version.definition.nodes.map((node) => node.id)
      const replies: ExecutionResult[] = [
        result({ kind: 'finish' }, { task: 'Open google.com and take a screenshot' }),
        result({ kind: 'finish' }, { screenshot: 'viewport.png' }),
        result({ kind: 'return', outcome: 'needs_changes' }, { fix: 'Capture the full page' }),
        result({ kind: 'finish' }, { screenshot: 'full-page.png' }),
        result({ kind: 'return', outcome: 'accepted' }, { approved: 'full-page.png' }),
      ]
      const nodes: string[] = []
      await runtime(f, async (execution) => {
        if (execution.state === 'completed') return
        nodes.push(execution.workflowNodeId)
        const reply = replies[nodes.length - 1]
        assert.ok(reply, `unexpected execution ${nodes.length} on ${execution.workflowNodeId}`)
        await f.finish(execution.id, reply)
      })()
      expect(nodes).toEqual([orchestrator, worker, orchestrator, worker, orchestrator])
      expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    }, 'sequential', { roles: ['orchestrator', 'coder'] })
  }, timeout)

  it('sends Worker findings back to the Orchestrator instead of waiting for the owner', async () => {
    await withFixture(team, async (f) => {
      const [orchestrator] = f.version.definition.nodes.map((node) => node.id)
      const replies: ExecutionResult[] = [
        result({ kind: 'finish' }, { task: 'Open google.com and take a screenshot' }),
        result({ kind: 'finish' }, { attempted: 'google.com' }, ['The browser could not reach google.com']),
        result({ kind: 'return', outcome: 'accepted' }, { accepted: 'Reported the blocker' }),
      ]
      const nodes: string[] = []
      await runtime(f, async (execution) => {
        if (execution.state === 'completed') return
        nodes.push(execution.workflowNodeId)
        const work = WorkActivationInputSchema.parse(execution.input).work
        if (nodes.length === 3) {
          assert.ok(work.kind === 'work_request')
          expect(work.acceptedSourceResult).toMatchObject({ output: { data: {
            remainingFindings: ['The browser could not reach google.com'] } } })
        }
        await f.finish(execution.id, replies[nodes.length - 1]!)
      })()
      expect(nodes).toHaveLength(3)
      expect(nodes[2]).toBe(orchestrator)
      expect(await hasWorkDirectionWait(f.owner)).toBe(false)
      expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    }, 'sequential', { roles: ['orchestrator', 'coder'] })
  }, timeout)

  it('fails the Run with the Orchestrator\'s reason when it finishes with findings instead of waiting for the owner', async () => {
    await withFixture(team, async (f) => {
      const execute = runtime(f, async (execution) => {
        if (execution.state !== 'completed') await f.finish(execution.id, result({ kind: 'finish' },
          { note: 'Could not reach the other agent' }, ['No inter-agent communication tools available']))
      })
      await expect(execute()).rejects.toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED' })
      expect(await hasWorkDirectionWait(f.owner)).toBe(false)
      expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'failed', result: { outcome: 'failed',
        error: { code: 'WORK_FINISHED_WITH_FINDINGS',
          message: 'Orchestrator finished with unresolved findings: No inter-agent communication tools available' } } })
    }, 'sequential', { roles: ['orchestrator', 'coder'] })
  }, timeout)

  it('keeps a plain Worker-to-Worker chain one-way: the last Worker finishes the Run', async () => {
    await withFixture(team, async (f) => {
      const nodes: string[] = []
      await runtime(f, async (execution) => {
        if (execution.state === 'completed') return
        nodes.push(execution.workflowNodeId)
        await f.finish(execution.id, result({ kind: 'finish' }, { step: nodes.length }))
      })()
      expect(nodes).toEqual(f.version.definition.nodes.map((node) => node.id))
      expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    }, 'sequential', { roles: ['coder', 'coder'] })
  }, timeout)
})

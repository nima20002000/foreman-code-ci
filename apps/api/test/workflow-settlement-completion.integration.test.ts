import { MemorySaver } from '@langchain/langgraph'
import { describe, expect, it, vi } from 'vitest'
import type { ExecutionResult, HarnessExecution } from '@foreman-code/contracts'
import { CANONICAL_RUN_GRAPH_MCP_TOOLS, CanonicalRunGraphCurrentSchema } from '@foreman-code/contracts/current'
import { graphRpcValue } from './graph-composition-fixture.js'
import { hasWorkDirectionWait } from '../src/modules/runs/workflowLifecycle.js'
import {
  useSettlementFixtures, timeout, finish, handoffs, acceptedActivation, runtime,
} from './helpers/workflowSettlementTestSupport.js'
import { postgresEnabled } from './helpers/database.js'

// Native terminals and physical closure are explicit test inputs. Authenticated
// Save/MCP reads, canonical publication, SQL transactions and settlement execute.
vi.mock('../src/modules/interactions/repeatNativeSettlement.js', async (importOriginal) => ({
  ...await importOriginal<Record<string, unknown>>(),
  settleRepeatNativeExecutionLocked: vi.fn(async () => undefined),
  settleRepeatNativeExecutionWithProofLocked: vi.fn(async () => undefined),
}))

describe.skipIf(!postgresEnabled)('workflow settlement completion', () => {
  const withFixture = useSettlementFixtures()

  it.each(['none', 'accepted', 'checkpoint'] as const)(
    'finalizes a sole finish result without findings (restart point: %s)', async (restartAt) => {
      await withFixture((graph) => ({ ...handoffs(1)(graph),
        executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 },
      }), async (f) => {
        const saver = new MemorySaver()
        const before = await f.readRun()
        let launches = 0
        const execute = runtime(f, async (execution) => {
          if (execution.state === 'completed') return
          launches++
          await f.finish(execution.id, finish())
        }, saver)
        if (restartAt === 'accepted') {
          await acceptedActivation(f, await f.store.ensureWorkEntry(), finish())
          await f.restart()
        }
        if (restartAt === 'checkpoint') {
          const crash = new Error('Run completion unavailable after the graph checkpoint')
          f.store.completeWorkRun = async () => { throw crash }
          await expect(execute()).rejects.toBe(crash)
          expect(await f.readRun()).toMatchObject({ executionState: 'running', outcome: 'pending' })
          await f.restart()
        }
        await execute()
        const completed = await f.readRun()
        expect(completed).toMatchObject({ executionState: 'completed', outcome: 'succeeded',
          workflowVersionId: before.workflowVersionId, startedAt: before.startedAt,
          result: { outcome: 'succeeded', output: finish().output },
        })
        expect(launches).toBe(restartAt === 'accepted' ? 0 : 1)
        const executions = await f.db.pool.query<{ record: HarnessExecution; accepted: boolean }>(
          'select record,accepted from harness_executions where run_id=$1', [f.run.id])
        expect(executions.rows).toHaveLength(1)
        expect(executions.rows[0]).toMatchObject({ accepted: true,
          record: { state: 'completed', result: finish() },
        })
        const read = await f.call(CANONICAL_RUN_GRAPH_MCP_TOOLS.current, { protocolVersion: 1, scope: f.scope })
        expect(read.result?.isError, JSON.stringify(read)).not.toBe(true)
        const persisted = CanonicalRunGraphCurrentSchema.parse(graphRpcValue(read.result))
        expect(persisted.state.run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
        expect(persisted.state.executions).toHaveLength(1)
        const denied = await f.credential([{ actions: ['workflows:read'],
          scope: { workspaceIds: [f.run.workspaceId] },
        }])
        const denial = await f.call(CANONICAL_RUN_GRAPH_MCP_TOOLS.current,
          { protocolVersion: 1, scope: f.scope }, denied.token)
        expect(denial.result?.isError).toBe(true)
        await f.restart()
        expect(await f.store.completeWorkRun()).toBe('completed')
        expect(await f.readRun()).toEqual(completed)
        expect(await hasWorkDirectionWait(f.owner)).toBe(false)
      }, 'single')
    }, timeout,
  )

  it('fails a sole finish result with findings with the Agent\'s reason instead of waiting for direction', async () => {
    await withFixture((graph) => ({ ...handoffs(1)(graph),
      executionPolicy: { maxParallelism: 1, maxNodeExecutions: 1 },
    }), async (f) => {
      const result: ExecutionResult = { outcome: 'succeeded', output: {
        routing: { kind: 'finish' }, data: { latestDeliverable: { revision: 1 },
          remainingFindings: ['Full verification remains pending', 'Worktree retained for the orchestrator'],
        },
      } }
      let launches = 0
      const execute = runtime(f, async (execution) => {
        if (execution.state === 'completed') return
        launches++
        await f.finish(execution.id, result)
      })
      await expect(execute()).rejects.toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED' })
      expect(await f.readRun()).toMatchObject({ executionState: 'completed', outcome: 'failed', result: { outcome: 'failed', error: {
        code: 'WORK_FINISHED_WITH_FINDINGS',
        message: expect.stringContaining('finished with unresolved findings: Full verification remains pending; Worktree retained for the orchestrator'),
      } } })
      expect(await hasWorkDirectionWait(f.owner)).toBe(false)
      expect(launches).toBe(1)
      const read = await f.call(CANONICAL_RUN_GRAPH_MCP_TOOLS.current, { protocolVersion: 1, scope: f.scope })
      expect(read.result?.isError, JSON.stringify(read)).not.toBe(true)
      const persisted = CanonicalRunGraphCurrentSchema.parse(graphRpcValue(read.result))
      expect(persisted.state.run).toMatchObject({ executionState: 'completed', outcome: 'failed', pendingInteractionCount: 0 })
      expect(persisted.state.executions).toHaveLength(1)
    }, 'single')
  }, timeout)

})

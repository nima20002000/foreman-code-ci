import { randomUUID } from 'node:crypto'
import { describe, expect, it, vi } from 'vitest'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { CURRENT_WORKFLOW_TOOLS, CurrentWorkflowSaveResultSchema, ManualRunStartResultSchema,
  makeCurrentWorkflowFixture } from '@foreman-code/contracts/wave25'
import { PostgresWorkflowClosureStore } from '../src/modules/interactions/workflowClosure.js'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { deferred, postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('restart during native startup', () => {
  for (const boundary of ['reservation', 'authorization'] as const) {
    it.each([false, true])(
      `drains rejected ${boundary} preflight and preserves the Run (disposal fails first=%s)`, async failFirst => {
        const runtime = await currentOperatorIntegration({ fixture: makeCurrentWorkflowFixture(randomUUID(), 'single'),
          approvalNodeIds: [], insertRun: false })
        const release = deferred()
        let paused = false
        let startupFailure: unknown
        let failDisposal = failFirst
        let disposalAttempts = 0
        let disposed = 0
        let shutdown: Promise<unknown> | undefined
        const connection = runtime.provider.connection.bind(runtime.provider)
        const connections = vi.spyOn(runtime.provider, 'connection').mockImplementation(() => {
          const manager = connection()
          const dispose = manager.dispose?.bind(manager)
          if (!dispose) throw new Error('Expected provider disposal.')
          return { ...manager, dispose: async () => {
            disposalAttempts++
            if (failDisposal) {
              failDisposal = false
              throw new Error('Original transport disposal is unconfirmed.')
            }
            await dispose()
            disposed++
          } }
        })
        const begin = PostgresWorkflowClosureStore.prototype.begin
        const reservation = vi.spyOn(PostgresWorkflowClosureStore.prototype, 'begin')
          .mockImplementation(async function (this: PostgresWorkflowClosureStore, execution) {
            if (boundary === 'reservation' && !paused) {
              paused = true
              await release.promise
            }
            try {
              return await begin.call(this, execution)
            } catch (error) {
              startupFailure = error
              throw error
            }
          })
        const authorize = runtime.locations.revalidateRunAuthorization.bind(runtime.locations)
        const authorization = vi.spyOn(runtime.locations, 'revalidateRunAuthorization')
          .mockImplementation(async (...args) => {
            if (boundary === 'authorization' && !paused && args[3] === runtime.db.pool) {
              const registered = await runtime.db.pool.query('select 1 from execution_native_closures')
              if (registered.rowCount) {
                paused = true
                await release.promise
              }
            }
            try {
              return await authorize(...args)
            } catch (error) {
              startupFailure = error
              throw error
            }
          })
        const close = vi.spyOn(runtime.native, 'closeForRestart')
        try {
          const savedResponse = await runtime.client.callTool({ name: CURRENT_WORKFLOW_TOOLS.save,
            arguments: await runtime.create() })
          expect(savedResponse.isError).not.toBe(true)
          const saved = CurrentWorkflowSaveResultSchema.parse(decodeMcpToolResult(savedResponse)).value
          const startedResponse = await runtime.client.callTool({ name: 'run_start', arguments: {
            workspaceId: saved.workspaceId, workflowId: saved.workflowId, workflowVersionId: saved.version.id,
            commandId: randomUUID(), executionSemanticsVersion: 3, expectedWorkflowRevision: saved.revision,
            expectedAgentConfigurationVersionIds: saved.version.agentConfigurationVersionIds,
            expectedLocationRevision: 1, input: {},
          } })
          expect(startedResponse.isError).not.toBe(true)
          const started = ManualRunStartResultSchema.parse(decodeMcpToolResult(startedResponse))
          await vi.waitFor(() => expect(paused).toBe(true), { timeout: 5_000 })
          shutdown = runtime.engine.shutdown().then(() => undefined, (error: unknown) => error)
          await vi.waitFor(() => expect(close).toHaveBeenCalledTimes(1), { timeout: 5_000 })
          const cleanup = await runtime.db.pool.query('select run_id from run_cleanup_intents where run_id=$1 and pending',
            [started.run.id])
          expect(cleanup.rows).toEqual([{ run_id: started.run.id }])
          release.resolve()
          const shutdownError = await shutdown
          expect(startupFailure).toMatchObject({ code: boundary === 'reservation'
            ? 'NATIVE_WORKFLOW_CLOSURE_CONFLICT' : 'RUN_AUTHORIZATION_REVOKED' })
          if (failFirst) {
            expect(shutdownError).toBeInstanceOf(AggregateError)
            expect(disposed).toBe(0)
            await runtime.engine.shutdown()
          } else {
            expect(shutdownError).toBeUndefined()
          }
          expect(disposed).toBe(1)
          expect(disposalAttempts).toBe(failFirst ? 2 : 1)
          expect(runtime.provider.counts).toMatchObject({ sessions: 0, starts: 0 })
          const read = await runtime.client.callTool({ name: 'run_get', arguments: {
            workspaceId: saved.workspaceId, runId: started.run.id, detail: 'full',
          } })
          expect(read.isError).not.toBe(true)
          expect(decodeMcpToolResult(read)).toMatchObject({ run: {
            id: started.run.id, workflowVersionId: saved.version.id, outcome: 'pending',
          } })
        } finally {
          release.resolve()
          failDisposal = false
          await shutdown
          try {
            await runtime.close()
          } finally {
            connections.mockRestore()
            reservation.mockRestore()
            authorization.mockRestore()
            close.mockRestore()
          }
        }
      }, 60_000,
    )
  }
})

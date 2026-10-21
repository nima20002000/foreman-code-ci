import { stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import { RemoteOperationReceiptSchema } from '@foreman-code/contracts/remote-execution'
import { remoteReviewProduction, waitForRemoteReview } from './remoteReviewProduction.js'
import { completedRun, startWhenReady } from './harnessInstallationUpdate.js'
import { expectMcpAccessDenied } from './deniedMcpTool.js'
import { readWorkflowClosure } from '../../src/modules/interactions/workflowClosure.js'
import { InstalledWorkflowRecovery } from '../../src/modules/runs/remote/installedWorkflowRecovery.js'

async function workerRecoveryDirectories(f: Awaited<ReturnType<typeof remoteReviewProduction>>) {
  const rows = await f.db.pool.query<{ receipt: unknown }>('select receipt from remote_execution_receipts')
  const recovery = new InstalledWorkflowRecovery(join(f.stateDirectory, 'workflow-recovery'), f.registry)
  return Promise.all(rows.rows.map(async row => {
    const receipt = RemoteOperationReceiptSchema.parse(row.receipt)
    const capture = recovery.read(receipt)
    if (!capture) return { executionId: receipt.intent.executionId, captured: false }
    const paths = {
      sourceRoot: capture.source.record.receipt.binding.canonicalPath,
      sourceTree: capture.source.workingTree.canonicalProjectRoot,
      sourceCwd: capture.source.workingTree.canonicalCwd,
      runtimeRoot: capture.approvedRoots.managedRuntimeRoot,
      runtimeLeaf: capture.runtimeLeaf.canonicalRuntimeDirectory,
      runtimeMarker: join(capture.runtimeLeaf.canonicalRuntimeDirectory, '.graphql-workflow-runtime.json'),
    }
    const inspections = await Promise.allSettled(Object.values(paths).map(path => stat(path)))
    return { executionId: receipt.intent.executionId, directories: Object.fromEntries(
      Object.keys(paths).map((name, index) => {
        const result = inspections[index]!
        return [name, result.status === 'fulfilled' ? 'present' : String(result.reason)]
      })) }
  }))
}

export async function assertWorkerOutputSettlement(cut: 'pending' | 'retired' = 'pending'): Promise<void> {
  const f = await remoteReviewProduction({ workflow: 'single', executionHost: 'worker',
    parallelSetup: true, parallelProfileChecks: true, includeNodeRuntimePayload: false })
  let failure: unknown
  try {
    await writeFile(join(f.provider.directory, 'workflow-answers.json'), JSON.stringify([JSON.stringify({
      data: 'Completed work', summary: 'Completed work.', board: { kind: 'none', reason: 'no_access' },
    })]))
    const interrupted = cut === 'pending' ? f.dropNextSettlement() : f.holdNextRetirementReply()
    let reached = false
    void interrupted.then(() => { reached = true })
    const started = (await startWhenReady(f))!
    await waitForRemoteReview(async () => reached, value => value, `Worker ${cut} settlement interruption`)
    const reply = await interrupted
    if (cut === 'retired') expect(reply).toMatchObject({ status: 'retired' })
    const before = await f.details(started.run.id)
    expect(before.executions).toHaveLength(1)
    expect(before.executions[0]).toMatchObject({ state: 'completed', result: { outcome: 'succeeded' } })
    const startup = await f.workerWorkflowStartup()
    if (cut === 'pending') {
      expect(startup).toContainEqual(expect.objectContaining({
        executionId: before.executions[0]!.id, terminal: undefined, stopFence: false,
      }))
    } else {
      expect(startup.some(item => item.executionId === before.executions[0]!.id)).toBe(false)
      const closure = await f.db.pool.query<{ closed: boolean }>(
        `select closed_at is not null as closed from execution_native_closures
          where execution_id=$1 order by generation desc limit 1`,
        [before.executions[0]!.id])
      expect(closure.rows).toEqual([{ closed: false }])
    }
    const reader = await f.access.issue({ name: 'Output recovery reader', audience: 'operator',
      expiresAt: new Date(Date.now() + 600000),
      grants: [{ actions: ['runs:read'], scope: { workspaceIds: [started.run.workspaceId] } }] })
    await expectMcpAccessDenied(f.call('run_stop', { workspaceId: started.run.workspaceId, runId: started.run.id }, reader.token))
    await f.restartMain({ mode: 'crash', afterShutdown: async () => { f.resumeWorkerConnection() } })
    const finished = await completedRun(f, started.run.id)
    expect(finished.executions).toHaveLength(1)
    const execution = finished.executions[0]!
    expect(execution).toMatchObject({ state: 'completed', attempt: 1, result: { outcome: 'succeeded' } })
    expect(execution.id).toBe(before.executions[0]!.id)
    expect(execution.nativeSessionId).toBe(before.executions[0]!.nativeSessionId)
    expect(execution.result).toEqual(before.executions[0]!.result)
    expect(await readWorkflowClosure(f.db.pool, execution)).toMatchObject({
      session: { nativeSessionId: execution.nativeSessionId },
    })
    await f.reconcile()
    expect((await f.details(started.run.id)).run).toMatchObject({ executionState: 'completed', outcome: 'succeeded' })
    expect(await readWorkflowClosure(f.db.pool, execution)).toMatchObject({
      session: { nativeSessionId: execution.nativeSessionId },
    })
    const calls = await f.provider.calls()
    expect(calls.filter(call => call.method === 'turn/start'
      && call.correlationId === `execution:${execution.id}`)).toHaveLength(1)
    expect(calls.some(call => call.method === 'turn/interrupt' && call.threadId === execution.nativeSessionId)).toBe(false)
    const receipts = await f.db.pool.query<{ receipt: unknown }>(`select receipt from remote_execution_receipts
      where receipt#>>'{intent,executionId}'=$1`, [execution.id])
    expect(receipts.rows).toHaveLength(1)
    expect(RemoteOperationReceiptSchema.parse(receipts.rows[0]!.receipt)).toMatchObject({
      outputValidationComplete: true, terminal: { kind: 'completed' }, native: { sessionId: execution.nativeSessionId },
    })
  } catch (error) {
    failure = error
    console.error('Worker output settlement failed', error)
    console.error('Worker recovery directories', JSON.stringify(await workerRecoveryDirectories(f)))
    console.error('Worker output failure details', JSON.stringify(f.failures()))
    throw error
  } finally {
    f.resumeWorkerConnection()
    try { await f.close() } catch (cleanupError) {
      if (failure) throw new AggregateError([failure, cleanupError], 'Worker settlement and cleanup failed.', { cause: failure })
      throw cleanupError
    }
  }
}

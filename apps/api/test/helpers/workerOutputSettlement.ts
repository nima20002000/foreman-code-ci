import { writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { expect } from 'vitest'
import { remoteReviewProduction, waitForRemoteReview } from './remoteReviewProduction.js'
import { completedRun, startWhenReady } from './harnessInstallationUpdate.js'

export async function assertWorkerOutputSettlement(): Promise<void> {
  const f = await remoteReviewProduction({ workflow: 'single', executionHost: 'worker',
    parallelSetup: true, parallelProfileChecks: true, includeNodeRuntimePayload: false })
  try {
    await writeFile(join(f.provider.directory, 'workflow-answers.json'), JSON.stringify([JSON.stringify({
      data: 'Completed work', summary: 'Completed work.', board: { kind: 'none', reason: 'no_access' },
    })]))
    const interrupted = f.dropNextSettlement()
    const started = (await startWhenReady(f))!
    await interrupted
    const before = await f.details(started.run.id)
    expect(before.executions).toHaveLength(1)
    expect(before.executions[0]).toMatchObject({ state: 'completed', result: { outcome: 'succeeded' } })
    expect(await f.workerWorkflowStartup()).toContainEqual(expect.objectContaining({
      executionId: before.executions[0]!.id, terminal: undefined, stopFence: false,
    }))
    await f.restartMain({ mode: 'crash', afterShutdown: async () => { f.resumeWorkerConnection() } })
    const finished = await completedRun(f, started.run.id)
    expect(finished.executions).toHaveLength(1)
    const execution = finished.executions[0]!
    expect(execution).toMatchObject({ state: 'completed', attempt: 1, result: { outcome: 'succeeded' } })
    const calls = await f.provider.calls()
    expect(calls.filter(call => call.method === 'turn/start'
      && call.correlationId === `execution:${execution.id}`)).toHaveLength(1)
    expect(calls.some(call => call.method === 'turn/interrupt' && call.threadId === execution.nativeSessionId)).toBe(false)
    await waitForRemoteReview(() => f.workerWorkflowStartup(), rows => rows.some(row =>
      row.executionId === execution.id && row.terminal !== undefined), 'settled original Worker receipt')
  } catch (error) {
    console.error('Worker output settlement failed', error)
    console.error('Worker output failure details', JSON.stringify(f.failures()))
    throw error
  } finally { f.resumeWorkerConnection(); await f.close() }
}

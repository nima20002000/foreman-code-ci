import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { faultWorkflowFixture } from './helpers/faultWorkflowFixture.js'
import { readUntil } from './helpers/observableCondition.js'
import { postgresEnabled } from './helpers/database.js'

describe.runIf(postgresEnabled)('API restart while a loop check finishes', () => {
  let fixture: Awaited<ReturnType<typeof faultWorkflowFixture>> | undefined
  beforeAll(async () => { fixture = await faultWorkflowFixture({ loop: true }) }, 10_000)
  beforeAll(async () => { await fixture!.prepareEntry() }, 10_000)
  beforeAll(async () => { await fixture!.launch() }, 12_000)
  afterAll(async () => { await fixture?.close() }, 10_000)

  it('shuts down cleanly when the loop check turn completes just before the restart', async () => {
    const current = fixture!
    await readUntil(current.readExecutions, executions => executions.some(execution =>
      execution.workflowNodeId === current.entry.id && execution.state === 'running'
        && typeof execution.input === 'object' && execution.input !== null && 'tick' in execution.input
        && current.worker.replay.starts.some(turn => turn.correlationId === `execution:${execution.id}`)),
    { timeoutMs: 12_000, minimumReadIntervalMs: 250, description: 'a loop check in flight' })
    // close() completes the in-flight check turn and shuts the engine down at once, as a restart does.
    fixture = undefined
    await expect(current.close()).resolves.toBeUndefined()
  }, 30_000)
})

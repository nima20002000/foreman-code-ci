import { expect, it } from 'vitest'
import { currentOperatorIntegration } from './helpers/currentOperatorIntegration.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { memoryWorkflow, workflowMemory } from './helpers/memoryWorkflow.js'

it.runIf(postgresEnabled).each([{ finding: null }, { finding: '' }, { finding: [] }])('retains a JSON finding $finding through logical acceptance and fails the Run with it', async ({ finding }) => {
  const runtime = await currentOperatorIntegration({ fixture: memoryWorkflow('single'), approvalNodeIds: [],
    outputFor: () => ({ routing: { kind: 'finish' }, data: {
      latestDeliverable: { text: 'Needs direction' }, remainingFindings: [finding],
    } }),
  })
  try {
    const memory = await workflowMemory(runtime)
    // Logical acceptance keeps the finding; with nobody to hand it to, the Run fails with it as the reason.
    await expect(runtime.engine.start(runtime.f.run.id)).rejects.toMatchObject({ code: 'WORK_SELECTED_EXECUTION_FAILED' })
    const detail = await memory.read()
    expect(detail).toMatchObject({ card: { status: 'blocked', reason: expect.stringMatching(/\S/) },
      bindings: [{ state: expect.stringMatching(/^(blocked|failed)$/), reason: expect.stringMatching(/\S/) }] })
    const run = await runtime.runs.getDetails(memory.scope.workspaceId, runtime.f.run.id)
    expect(run?.run).toMatchObject({ executionState: 'completed', outcome: 'failed',
      result: { error: { code: 'WORK_FINISHED_WITH_FINDINGS' } } })
    expect(run?.executions[0]?.result).toMatchObject({ outcome: 'succeeded',
      output: { data: { remainingFindings: [finding] } } })
  } finally { await runtime.close() }
}, 60000)

import { describe, it } from 'vitest'
import { assertRejectedStartupRestart } from './helpers/workflowStartupRestart.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('restart during native startup', () => {
  it('rejects authorization preflight and preserves the Run', async () => {
    await assertRejectedStartupRestart({ boundary: 'authorization', disposal: 'succeed' })
  }, 60_000)
})

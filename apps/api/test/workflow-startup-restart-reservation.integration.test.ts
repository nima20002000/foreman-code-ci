import { describe, it } from 'vitest'
import { assertRejectedStartupRestart } from './helpers/workflowStartupRestart.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('restart during native startup', () => {
  it('rejects reservation preflight and preserves the Run', async () => {
    await assertRejectedStartupRestart({ boundary: 'reservation', disposal: 'succeed' })
  }, 60_000)
})

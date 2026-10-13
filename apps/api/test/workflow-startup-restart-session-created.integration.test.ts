import { describe, it } from 'vitest'
import { assertNativeStartupRestart } from './helpers/workflowStartupRestart.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('restart during native startup', () => {
  it('drains startup after native session creation before closing its original manager', async () => {
    await assertNativeStartupRestart('created')
  }, 60_000)
})

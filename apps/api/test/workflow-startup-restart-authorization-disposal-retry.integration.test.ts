import { describe, it } from 'vitest'
import { assertRejectedStartupRestart } from './helpers/workflowStartupRestart.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.runIf(postgresEnabled)('restart during native startup', () => {
  it('retries original manager disposal after authorization preflight rejection', async () => {
    await assertRejectedStartupRestart({ boundary: 'authorization', disposal: 'fail-first' })
  }, 60_000)
})

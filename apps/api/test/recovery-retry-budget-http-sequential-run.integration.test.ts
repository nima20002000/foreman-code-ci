import { it } from 'vitest'
import { assertFullRunRetryBudget, describeRetryBudget } from './helpers/retryBudget.js'

describeRetryBudget('sequential full-Run retry through HTTP', () => {
  it('Start replay creates only one new Run with a fresh technical budget', async () => {
    await assertFullRunRetryBudget('sequential', 'http')
  }, 90_000)
})

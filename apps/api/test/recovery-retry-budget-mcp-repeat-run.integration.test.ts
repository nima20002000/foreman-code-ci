import { it } from 'vitest'
import { assertFullRunRetryBudget, describeRetryBudget } from './helpers/retryBudget.js'

describeRetryBudget('repeat full-Run retry through MCP', () => {
  it('Start replay creates only one new Run with a fresh technical budget', async () => {
    await assertFullRunRetryBudget('repeat', 'mcp')
  }, 90_000)
})

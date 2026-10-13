import { it } from 'vitest'
import { assertFullRunRetryBudget, describeRetryBudget } from './helpers/retryBudget.js'

describeRetryBudget('sequential full-Run retry through MCP', () => {
  it('Start replay creates only one new Run with a fresh technical budget', async () => {
    await assertFullRunRetryBudget('sequential', 'mcp')
  }, 90_000)
})

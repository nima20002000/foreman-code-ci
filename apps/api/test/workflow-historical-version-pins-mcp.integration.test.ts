import { afterEach, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { assertHistoricalVersionPins } from './helpers/workflowVersionAssertions.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('immutable optional-repeat versions over MCP', () => {
  it('retains initial ordinary, repeat and final ordinary Run pins and evidence', async () => {
    await assertHistoricalVersionPins('mcp')
  }, 240000)
})

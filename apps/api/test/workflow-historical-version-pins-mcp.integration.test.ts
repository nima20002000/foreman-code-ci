import { afterEach, describe, it, vi } from 'vitest'
import { postgresEnabled } from './helpers/database.js'
import { assertHistoricalVersionPins } from './helpers/workflowVersionAssertions.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('immutable optional-repeat versions', () => {
  it('mcp retains initial ordinary, repeat and final ordinary Run pins and evidence', async () => {
    await assertHistoricalVersionPins('mcp')
  }, 240000)
})

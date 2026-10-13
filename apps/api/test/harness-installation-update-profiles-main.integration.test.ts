import { describe, it } from 'vitest'
import { assertUpdatedInstallationProfiles } from './helpers/harnessInstallationUpdateCases.js'

describe('installed harness updates', () => {
  it('automatically checks every qualified main profile and preserves the running process through authenticated MCP', async () => {
    await assertUpdatedInstallationProfiles('main')
  }, 240_000)
})

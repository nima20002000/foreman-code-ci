import { describe, it } from 'vitest'
import { assertUpdatedInstallationProfiles } from './helpers/harnessInstallationUpdateCases.js'

describe('installed harness updates', () => {
  it('automatically checks every qualified worker profile and preserves the running process through authenticated MCP', async () => {
    await assertUpdatedInstallationProfiles('worker')
  }, 240_000)
})

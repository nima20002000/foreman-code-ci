import { describe, it } from 'vitest'
import { assertResidentRunAcrossUnavailableInstallation } from './helpers/harnessInstallationUpdateCases.js'

describe('installed harness updates', () => {
  it('retains a resident main Run across unavailable inventory before a completed payload replacement', async () => {
    await assertResidentRunAcrossUnavailableInstallation('main')
  }, 240_000)
})

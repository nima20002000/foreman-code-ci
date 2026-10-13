import { describe, it } from 'vitest'
import { assertResidentRunAcrossUnavailableInstallation } from './helpers/harnessInstallationUpdateCases.js'

describe('installed harness updates', () => {
  it('retains a resident worker Run across unavailable inventory before a completed payload replacement', async () => {
    await assertResidentRunAcrossUnavailableInstallation('worker')
  }, 240_000)
})

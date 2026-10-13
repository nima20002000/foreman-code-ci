import { describe, it } from 'vitest'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'

describe('installed Main-local workflows across systemd restart', () => {
  it('uses a temporary unit, reattaches writable graph work after restart, and closes its processes', async () => {
    await assertInstalledWorkflowRestart('writable source')
  }, 600_000)
})

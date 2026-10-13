import { describe, expect, it } from 'vitest'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'
import { installationUpdateFixture, startWhenReady, completedRun } from './helpers/harnessInstallationUpdate.js'

describe('installed Main-local workflows across systemd restart', () => {
  it('starts a fresh installed service and completes a workflow through MCP', async () => {
    const fixture = await installationUpdateFixture({
      workflow: 'single', executionHost: 'main', installedMainService: true,
    })
    try {
      expect(await fixture.mainService!.state()).toBe('active')
      const started = await startWhenReady(fixture)
      expect(started).toBeDefined()
      const finished = await completedRun(fixture, started!.run.id)
      expect(finished.run.outcome).toBe('succeeded')
    } finally {
      await fixture.close()
    }
  }, 600_000)

  it('reattaches graph work and its admitting interval check, then closes their processes', async () => {
    await assertInstalledWorkflowRestart('admitting interval')
  }, 600_000)
})

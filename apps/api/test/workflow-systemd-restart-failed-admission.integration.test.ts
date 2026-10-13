import { describe, expect, it } from 'vitest'
import { installationUpdateFixture, profiles } from './helpers/harnessInstallationUpdate.js'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'

describe('installed Main-local workflows across systemd restart', () => {
  it('starts the installed API and reads configured profiles through authenticated MCP', async () => {
    const fixture = await installationUpdateFixture({ workflow: 'interval', executionHost: 'main',
      installedMainService: true })
    try {
      expect(await fixture.mainService!.state()).toBe('active')
      const configured = await profiles(fixture)
      expect(configured.map(profile => profile.instanceId))
        .toEqual(fixture.profiles.map(profile => profile.instanceId))
    } finally {
      await fixture.close()
    }
  }, 600_000)

  it('closes interrupted processes when interval admission fails during restart', async () => {
    await assertInstalledWorkflowRestart('failed admission')
  }, 600_000)
})

import { execFile } from 'node:child_process'
import { randomUUID } from 'node:crypto'
import { rm } from 'node:fs/promises'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { describe, expect, it } from 'vitest'
import { assertInstalledWorkflowRestart } from './helpers/installedWorkflowRestart.js'
import { installRestartServiceUnit } from './helpers/installedRestartService.js'
import { privateFixtureDirectory } from './helpers/privateFixtureDirectory.js'

const execute = promisify(execFile)

describe('installed Main-local workflows across systemd restart', () => {
  it('starts a service installed in a fresh fixture directory', async () => {
    const directory = await privateFixtureDirectory('installed-service-')
    const unit = `graphql-restart-${randomUUID()}.service`
    const unitPath = join(directory, 'systemd-user', unit)
    const hostRuntime = `/run/user/${process.getuid!()}`
    const systemctl = (...args: string[]) => execute('systemctl', ['--user', ...args], {
      timeout: 30_000,
      env: { ...process.env, XDG_RUNTIME_DIR: hostRuntime,
        DBUS_SESSION_BUS_ADDRESS: `unix:path=${hostRuntime}/bus` },
    })
    let installed = false
    try {
      await installRestartServiceUnit(unitPath,
        '[Service]\nType=oneshot\nExecStart=/usr/bin/true\nRemainAfterExit=yes\n', systemctl)
      installed = true
      await systemctl('start', unit)
      expect((await systemctl('show', unit, '--property=ActiveState', '--value')).stdout.trim()).toBe('active')
      await systemctl('restart', unit)
      expect((await systemctl('show', unit, '--property=ActiveState', '--value')).stdout.trim()).toBe('active')
      await systemctl('stop', unit)
      expect((await systemctl('show', unit, '--property=ActiveState', '--value')).stdout.trim()).toBe('inactive')
    } finally {
      if (installed) {
        await systemctl('stop', unit)
        await systemctl('--runtime', 'disable', unit)
        await systemctl('daemon-reload')
      }
      await rm(directory, { recursive: true, force: true })
    }
  }, 120_000)

  it('reattaches graph work and its active check, then closes their processes', async () => {
    await assertInstalledWorkflowRestart('active')
  }, 600_000)
})

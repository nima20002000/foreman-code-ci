import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { createBrowserHost, type BrowserHostOptions } from './hostFactory.js'
import { ManagedBrowserNativeDriver } from './nativeDriver.js'

const directories: string[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  for (const directory of directories.splice(0)) await rm(directory, { recursive: true, force: true })
})

it('closes every other profile and the virtual display when one profile will not close', async () => {
  const stateDirectory = await mkdtemp(join(tmpdir(), 'browser-host-close-'))
  directories.push(stateDirectory)
  vi.spyOn(ManagedBrowserNativeDriver.prototype, 'ownedProfileIds').mockReturnValue(['stuck', 'other'])
  const closeProfile = vi.spyOn(ManagedBrowserNativeDriver.prototype, 'closeProfile').mockImplementation(async profileId => {
    if (profileId === 'stuck') throw new Error('BROWSER_PROCESS_OWNERSHIP')
  })
  const closeDisplay = vi.spyOn(ManagedBrowserNativeDriver.prototype, 'closeVirtualDisplay').mockResolvedValue(undefined)
  const host = await createBrowserHost({ stateDirectory, computerId: 'computer', installationId: 'installation',
    runtime: { rootDirectory: stateDirectory, pythonExecutable: 'python', chromiumExecutable: 'chromium', bridgeScript: 'bridge.py',
      runtimeVersion: '1', profileFormat: 1 },
    subjectAuthority: {} as BrowserHostOptions['subjectAuthority'], pairing: {} as BrowserHostOptions['pairing'],
    keys: {} as BrowserHostOptions['keys'], assertHostOwnership: async () => undefined, reportFailure: () => undefined })
  await expect(host.close()).rejects.toThrow('BROWSER_PROCESS_OWNERSHIP')
  expect(closeProfile).toHaveBeenCalledWith('other')
  expect(closeDisplay).toHaveBeenCalledTimes(1)
})

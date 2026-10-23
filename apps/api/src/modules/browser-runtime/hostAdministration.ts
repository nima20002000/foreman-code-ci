import { createHostAdministration, type HostAdministration } from '../hostAdministration.js'
import { spawnProcess, hostEnvironment } from '../../shared/process.js'
import { configuredTemporaryDirectory } from '../../config.js'
import { atomicBrowserPrivateJson } from './journal.js'
import { browserProcessAlive, browserProcessBirthId } from './processIdentity.js'
import { createBrowserRuntimeDirectory, removeBrowserRuntimeDirectory, findBrowserVirtualDisplay } from '../../../../worker/src/browserRuntimeInstall.mjs'

export function createBrowserAdministration(actionDirectory: string): HostAdministration['browser'] {
  return createHostAdministration({ actionDirectory, browser: {
    spawn: (binary, args, options) => spawnProcess(binary, args, { ...options, shell: false }),
    environment: hostEnvironment, temporaryDirectory: configuredTemporaryDirectory,
    findVirtualDisplay: findBrowserVirtualDisplay, processAlive: browserProcessAlive, processBirthId: browserProcessBirthId,
    writePrivateJson: atomicBrowserPrivateJson, createRuntimeDirectory: createBrowserRuntimeDirectory,
    removeRuntimeDirectory: removeBrowserRuntimeDirectory,
  } }).browser
}

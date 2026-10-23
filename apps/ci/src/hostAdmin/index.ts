// Machine administration: what the API asks of the computer it runs on, and what a paired computer's agent does for
// Main. The API calls HostAdministration and does not run OS commands itself.
import { HostSystem, type HostSystemPorts } from './system.js'
import { SyncthingComputer } from './syncthingComputer.js'
import type { SyncthingPorts } from './syncthingSystem.js'
import { HostBrowser, type HostBrowserPorts } from './browser.js'

export { HostSystem } from './system.js'
export type { HostStep, HostSystemPorts } from './system.js'
export { SyncthingComputer, sharedFolderId } from './syncthingComputer.js'
export { systemSyncthingPorts } from './syncthingSystem.js'
export type { SyncthingPorts, SyncthingProcessPorts } from './syncthingSystem.js'
export { HostBrowser } from './browser.js'
export type { HostBrowserPorts, HostBrowserRuntimeDirectory } from './browser.js'

/** The one interface the API calls for machine administration. */
export interface HostAdministration {
  /** OS packages and restarts. */
  readonly system: HostSystem
  /** Shared-folder service on this computer. */
  readonly syncthing: SyncthingComputer
  /** Chromium processes and their shared virtual display. */
  readonly browser: HostBrowser
}

/** Each component is created at its owning host service's lifetime boundary. */
export function createHostAdministration(ports: HostSystemPorts): Pick<HostAdministration, 'system'>
export function createHostAdministration(ports: { syncthing: SyncthingPorts; reportScanFailure(error: unknown): void }): Pick<HostAdministration, 'syncthing'>
export function createHostAdministration(ports: { browser: HostBrowserPorts; actionDirectory: string }): Pick<HostAdministration, 'browser'>
export function createHostAdministration(ports: HostSystemPorts
  | { syncthing: SyncthingPorts; reportScanFailure(error: unknown): void }
  | { browser: HostBrowserPorts; actionDirectory: string }): Partial<HostAdministration> {
  if ('syncthing' in ports) return { syncthing: new SyncthingComputer(ports.syncthing, ports.reportScanFailure) }
  if ('browser' in ports) return { browser: new HostBrowser(ports.actionDirectory, ports.browser) }
  return { system: new HostSystem(ports) }
}

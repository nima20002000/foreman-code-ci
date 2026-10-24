import { createHostAdministration, type HostAdministration } from '../hostAdministration.js'
import { logIgnoredError } from '../diagnostics/index.js'
import { systemSyncthingPorts, type SyncthingPorts } from './syncthingSystem.js'

export { sharedFolderId } from '../hostAdministration.js'

export class SyncthingComputer {
  private readonly host: Pick<HostAdministration, 'syncthing'>
  constructor(ports: SyncthingPorts = systemSyncthingPorts()) {
    this.host = createHostAdministration({ syncthing: ports,
      reportScanFailure: error => logIgnoredError('lifecycle', 'scan shared file conflicts', error, { nextRetryMs: 300_000 }) })
  }

  handle(...args: Parameters<HostAdministration['syncthing']['handle']>) { return this.host.syncthing.handle(...args) }
  status(...args: Parameters<HostAdministration['syncthing']['status']>) { return this.host.syncthing.status(...args) }
}

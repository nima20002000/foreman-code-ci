import { systemSyncthingPorts as createPorts, type SyncthingPorts } from '../hostAdministration.js'
import { systemPorts } from './accountProbe.js'
import { hostEnvironment } from '../../shared/process.js'

export type { SyncthingPorts }

export function systemSyncthingPorts(environment: NodeJS.ProcessEnv = hostEnvironment()): SyncthingPorts {
  return createPorts(systemPorts(environment), environment)
}

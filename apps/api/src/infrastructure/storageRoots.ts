import { INSTALLATION_NAMES } from '@foreman-code/contracts/installation-names'
import { homedir } from 'node:os'
import { join } from 'node:path'

export function defaultFileStorageRoot(): string {
  return join(homedir(), '.local', 'share', INSTALLATION_NAMES.paths.storageDirectory, 'files')
}

/** Durable project data is separate from application code and harness runtime state. */
export function workspaceStorageRoot(): string {
  return join(homedir(), '.local', 'share', INSTALLATION_NAMES.paths.storageDirectory, 'workspaces')
}

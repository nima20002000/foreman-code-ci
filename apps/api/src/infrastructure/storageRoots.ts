import { homedir } from 'node:os'
import { join } from 'node:path'

export function defaultFileStorageRoot(): string {
  return join(homedir(), '.local', 'share', 'graphql', 'files')
}

/** Durable project data is separate from application code and harness runtime state. */
export function workspaceStorageRoot(): string {
  return join(homedir(), '.local', 'share', 'graphql', 'workspaces')
}

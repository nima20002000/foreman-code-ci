import { isReadOnlyHarnessConfiguration, type AgentConfigurationVersion } from '@foreman-code/contracts'
import type { WorkspaceLocationAccessMode } from '@foreman-code/contracts/management'

export function requiredLocationAccess(configurations: readonly AgentConfigurationVersion[]): WorkspaceLocationAccessMode {
  return configurations.some((configuration) => !isReadOnlyHarnessConfiguration(configuration.harness)) ? 'read-write' : 'read-only'
}

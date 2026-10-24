import { RETIRED_OPENCODE_MESSAGE, type HarnessConfiguration, type RecordedHarnessConfiguration } from '@foreman-code/contracts'
import type { MaintainedHarness } from '@foreman-code/contracts/computer-maintenance'
import { DomainError } from '../modules/errors.js'

/**
 * Static control descriptors per harness. Code outside `modules/harnesses/` asks these instead of comparing
 * provider names: input identity, file delivery, application MCP startup and supported session controls.
 * This policy imports no control-plane services so Main and Worker can share it.
 */

/** `native_expected_turn`: the provider adds input to the exact active turn and rejects it when that turn ended. */
export type HarnessSteerDescriptor = 'native_expected_turn' | 'unavailable'
export type HarnessCompactDescriptor = 'native' | 'unavailable'

export interface HarnessCapabilityDescriptors {
  readonly steer: HarnessSteerDescriptor
  readonly compact: HarnessCompactDescriptor
  readonly inputIdentity: 'turn' | 'message' | 'unavailable'
  readonly files: 'turn_mcp' | 'session_bridge' | 'unavailable'
  readonly applicationMcp: 'session_config' | 'startup_config' | 'unavailable'
  readonly autoCompact: boolean
}

/** Codex app-server steers through the protocol-qualified `turn/steer` method. */
export const CODEX_CAPABILITY_DESCRIPTORS: HarnessCapabilityDescriptors = { steer: 'native_expected_turn', compact: 'native',
  inputIdentity: 'turn', files: 'turn_mcp', applicationMcp: 'session_config', autoCompact: false }

/** Claude has no expected-turn steer; callers use Queue or Interrupt and send. */
export const CLAUDE_CAPABILITY_DESCRIPTORS: HarnessCapabilityDescriptors = { steer: 'unavailable', compact: 'native',
  inputIdentity: 'message', files: 'session_bridge', applicationMcp: 'startup_config', autoCompact: true }

const NO_CAPABILITIES: HarnessCapabilityDescriptors = { steer: 'unavailable', compact: 'unavailable',
  inputIdentity: 'unavailable', files: 'unavailable', applicationMcp: 'unavailable', autoCompact: false }

/** Descriptors for a harness name; an unknown or retired harness has none. */
export function harnessCapabilityDescriptors(harness: string): HarnessCapabilityDescriptors {
  if (harness === 'codex') return CODEX_CAPABILITY_DESCRIPTORS
  if (harness === 'claude') return CLAUDE_CAPABILITY_DESCRIPTORS
  return NO_CAPABILITIES
}

/** Accepts a manager, session, conversation row or configuration: any `harness` carrier. A manager's own
 * descriptors win over the table. */
export function capabilityDescriptorsOf(subject: { readonly harness: string; readonly harnessCapabilities?: HarnessCapabilityDescriptors | undefined }):
  HarnessCapabilityDescriptors {
  return subject.harnessCapabilities ?? harnessCapabilityDescriptors(subject.harness)
}

/** True when the harness can add input to the exact active native turn. */
export function supportsExpectedTurnSteer(subject: Parameters<typeof capabilityDescriptorsOf>[0]): boolean {
  return capabilityDescriptorsOf(subject).steer === 'native_expected_turn'
}

/** Saved OpenCode history stays readable; nothing that names it may execute or be written. */
export function retiredHarnessError(): DomainError {
  return new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
}

/** Narrow a saved configuration at execution admission without altering the recorded snapshot. */
export function assertActiveHarnessConfiguration(configuration: RecordedHarnessConfiguration): asserts configuration is HarnessConfiguration {
  if (configuration.harness === 'opencode') throw retiredHarnessError()
}

/** Native storage and CLI contracts used by computer maintenance. */
const MAINTENANCE_CAPABILITIES = {
  codex: {
    homeEnvironmentVariable: 'CODEX_HOME', homeDirectory: '.codex', update: 'npm',
    plugins: { installCommand: 'add', scopeArguments: [], records: 'cache', cliResult: 'exit_code', marketplace: 'local_override' },
    mcp: { scopeArguments: [], registration: 'arguments', read: 'cli' },
  },
  claude: {
    homeEnvironmentVariable: 'CLAUDE_CONFIG_DIR', homeDirectory: '.claude', update: 'native',
    plugins: { installCommand: 'install', scopeArguments: ['--scope', 'user'], records: 'user', cliResult: 'json_outcome', marketplace: 'native' },
    mcp: { scopeArguments: ['--scope', 'user'], registration: 'json', read: 'user_config' },
  },
} as const

export function harnessMaintenanceCapabilities(harness: MaintainedHarness) {
  return MAINTENANCE_CAPABILITIES[harness]
}

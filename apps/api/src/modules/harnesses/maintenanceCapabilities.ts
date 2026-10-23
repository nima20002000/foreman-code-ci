import type { MaintainedHarness } from '@foreman-code/contracts/computer-maintenance'

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

import type { productionClaudeManager } from './claudeSdk/production.js'
import type { NativeHarnessSessionManager } from './port.js'
import type { NativeProcessRecovery } from './recovery/processRegistry.js'

/** The Claude manager a launch was built from, with its inspection start and credential refresh. */
export type ClaudeLaunch = ReturnType<typeof productionClaudeManager>

/**
 * What each native manager was launched with. The workflow and Operator manager factories record it as they allocate;
 * the coordinator, credential preparation and telemetry read it back by manager.
 */
export class NativeLaunchRecords {
  private readonly scopes = new WeakMap<NativeHarnessSessionManager, NativeProcessRecovery>()
  private readonly claudeLaunches = new WeakMap<NativeHarnessSessionManager, ClaudeLaunch>()

  recordScope(manager: NativeHarnessSessionManager, recovery: NativeProcessRecovery): void {
    this.scopes.set(manager, recovery)
  }

  /** The process-recovery scope reserved for this manager's lifetime. */
  scopeOf(manager: NativeHarnessSessionManager): NativeProcessRecovery | undefined {
    return this.scopes.get(manager)
  }

  recordClaude(launch: ClaudeLaunch): void {
    this.claudeLaunches.set(launch.manager, launch)
  }

  claudeOf(manager: NativeHarnessSessionManager): ClaudeLaunch | undefined {
    return this.claudeLaunches.get(manager)
  }
}

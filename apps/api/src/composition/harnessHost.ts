import { randomUUID } from 'node:crypto'
import type { CompatibilityHarness } from '@foreman-code/contracts'
import { DomainError } from '../modules/errors.js'
import type { ProductionHarnessInfrastructure } from '../modules/harnesses/productionInfrastructure.js'
import type { QualificationSuite } from '../modules/harnesses/qualification/types.js'

/** The one place production wiring reads the injected harness mode. */
export interface HarnessHost {
  /** `replay` drives recorded protocol below the real adapters. */
  mode: 'native' | 'replay'
  /** Installed CLIs are initialized, inspected and qualified only on a native host. */
  installedClis: boolean
  /** Identifies a diagnostic or configuration check's native process scope. */
  auxiliaryLaunchId(): string
}

export function createHarnessHost(infrastructure: ProductionHarnessInfrastructure | undefined,
  qualificationSuites: Record<CompatibilityHarness, QualificationSuite> | undefined): HarnessHost {
  if (infrastructure?.mode !== 'replay') return { mode: 'native', installedClis: true, auxiliaryLaunchId: () => randomUUID() }
  if (!infrastructure.auxiliary || !infrastructure.auxiliary.compatibility || !infrastructure.auxiliary.plugins
    || !infrastructure.auxiliary.mcp?.codex
    || !infrastructure.auxiliary.command || !infrastructure.auxiliary.recovery || !infrastructure.inventoryDiscovery || qualificationSuites) {
    throw new DomainError('HARNESS_REPLAY_INCOMPLETE', 'Replay must inject settings and probes and cannot run installed CLI qualification.', 500)
  }
  const codex = infrastructure.codex
  return { mode: 'replay', installedClis: false, auxiliaryLaunchId: () => codex.id() }
}

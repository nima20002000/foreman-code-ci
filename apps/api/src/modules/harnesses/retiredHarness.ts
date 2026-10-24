import { RETIRED_OPENCODE_MESSAGE, type HarnessConfiguration, type RecordedHarnessConfiguration } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'

/** Saved OpenCode history stays readable; nothing that names it may execute or be written. */
export function retiredHarnessError(): DomainError {
  return new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
}

/** Narrow a saved configuration at execution admission without altering the recorded snapshot. */
export function assertActiveHarnessConfiguration(configuration: RecordedHarnessConfiguration): asserts configuration is HarnessConfiguration {
  if (configuration.harness === 'opencode') throw retiredHarnessError()
}

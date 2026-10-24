import { RETIRED_OPENCODE_MESSAGE } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'

/** Saved OpenCode history stays readable; nothing that names it may execute or be written. */
export function retiredHarnessError(): DomainError {
  return new DomainError('HARNESS_RETIRED', RETIRED_OPENCODE_MESSAGE, 409)
}

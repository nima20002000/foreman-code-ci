import type { CiRunInput } from '@foreman-code/contracts'
import { DomainError } from '../errors.js'

/** Gate requests cover the whole suite even if their caller omits scope. */
export function requiresFullCiGrant(input: Pick<CiRunInput, 'suite' | 'scope' | 'files'> & { gate?: boolean }): boolean {
  return input.gate === true || input.scope === 'full'
    || !['unit', 'integration', 'lint', 'typecheck'].includes(input.suite)
    || input.suite === 'integration' && input.files === undefined
}

export function requireFullCiGrant(allowed: boolean, reason = 'This request runs the full suite.'): void {
  if (allowed) return
  throw new DomainError('CI_FULL_SCOPE_FORBIDDEN',
    `${reason} An explicit jobs:ci_full grant is required. Use scope=affected with files to run only affected checks.`, 403)
}

import { DomainError } from '../errors.js'
import { HarnessExecutionError } from './errors.js'
import { deviceBusyFailure } from '../devices/deviceBusyError.js'
import { DeviceApplicationError } from '../devices/deviceApplicationError.js'

const HARNESS_SIGN_IN_MESSAGE = 'Sign in to this harness on the server, then refresh.'

/** The harness answered that it is signed out. */
export function harnessSignInRequired(error: unknown): boolean {
  return error instanceof DomainError && error.details?.signInRequired === true
}

/** Every failure, including each one an automatic check batch collected, is a signed-out harness. */
export function onlySignInRequired(error: unknown): boolean {
  if (error instanceof AggregateError) return error.errors.length > 0 && error.errors.every(onlySignInRequired)
  return harnessSignInRequired(error)
}

/** Translate expected native readiness errors at the domain boundary, not all application errors. */
export function qualificationError(error: unknown): DomainError {
  error = deviceBusyFailure(error)
  if (error instanceof DomainError) return error
  if (error instanceof HarnessExecutionError) {
    const code = error.result.outcome === 'failed' ? error.result.error?.code ?? 'HARNESS_QUALIFICATION_FAILED' : 'HARNESS_QUALIFICATION_FAILED'
    if (/CONTRACT_UNSUPPORTED/.test(code)) return new DomainError(code, error.message, 422)
    const signIn = /AUTH|LOGIN/.test(code)
    const unavailable = /UNAVAILABLE|DISCONNECTED|TIMEOUT|UNQUALIFIED|SCHEMA|EXECUTABLE_CHANGED/.test(code)
    const message = signIn ? HARNESS_SIGN_IN_MESSAGE
      : code === 'CODEX_MODEL_CATALOG_UNAVAILABLE' ? 'The native model catalog could not be read. Check the native connection and sign-in, then refresh.'
      : code === 'CODEX_MODEL_UNAVAILABLE' ? 'The selected model is absent from the native Codex catalog. Refresh the catalog and review this selection.'
      : /MODEL_UNAVAILABLE/.test(code) ? 'This model is not available to the signed-in native harness.'
      : /SETTING_UNSUPPORTED/.test(code) ? 'The native harness does not support this model, effort, or setting combination.'
      : /MCP/.test(code) ? 'An MCP policy does not match the native server configuration. Review the MCP servers below.'
      : /VERSION|SCHEMA|UNQUALIFIED/.test(code) ? 'The installed harness has not satisfied the required native contract and host policy checks. Review its reported failure.'
      : unavailable ? 'The native harness could not be reached. Check its installation and sign-in, then refresh.'
      : 'The native harness rejected this configuration.'
    // Native stderr and configuration can contain credentials. Only a stable code leaves the server.
    // A signed-out harness is an ordinary state the owner fixes, not a server fault, and retrying cannot fix it.
    return new DomainError(code, message, signIn ? 409 : unavailable ? 503 : 422, signIn ? { signInRequired: true } : undefined)
  }
  if (error instanceof Error && ['TimeoutError', 'AbortError'].includes(error.name)) {
    return new DomainError('HARNESS_CHECK_TIMEOUT', 'The native check timed out. Try again.', 503)
  }
  return new DomainError('HARNESS_QUALIFICATION_FAILED', 'The native check could not complete. Check the server logs.', 503)
}

/** The checked target moved while the check ran: a retry on the settled inventory, never a verdict on the harness. */
export function staleQualification(error: unknown): boolean {
  if (error instanceof AggregateError) {
    return error.errors.length > 0 && error.errors.every(staleQualification)
  }
  return (error instanceof DomainError || error instanceof DeviceApplicationError)
    && ['HARNESS_INVENTORY_STALE', 'HARNESS_QUALIFICATION_TARGET_CHANGED'].includes(error.code)
}

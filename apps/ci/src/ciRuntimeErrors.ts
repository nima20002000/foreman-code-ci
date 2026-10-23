import type { CiContext } from './environment.js'
import { DomainError } from '@foreman-code/contracts/server-kit'

export function temporaryCiConnectionError(context: CiContext, error: unknown): boolean {
  if (context.platform.isDeviceApplicationError(error)) return error.retryable
  if (context.platform.isDeviceConnectionError(error)) return ['transport', 'timeout', 'backpressure'].includes(error.code)
  return error instanceof DomainError && error.code === 'COMPUTER_OFFLINE'
}

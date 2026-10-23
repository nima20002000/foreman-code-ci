import { isDeviceApplicationError, isDeviceConnectionError } from './environment.js'
import { DomainError } from '@foreman-code/contracts/server-kit'

export function temporaryCiConnectionError(error: unknown): boolean {
  if (isDeviceApplicationError(error)) return error.retryable
  if (isDeviceConnectionError(error)) return ['transport', 'timeout', 'backpressure'].includes(error.code)
  return error instanceof DomainError && error.code === 'COMPUTER_OFFLINE'
}

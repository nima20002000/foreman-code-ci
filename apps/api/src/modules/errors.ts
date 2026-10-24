import { isDatabasePoolTimeout, type FailureClass } from '@foreman-code/contracts/failure'
import { DomainError } from '@foreman-code/contracts-node/server-kit'
import { deviceApplicationFailure } from './devices/deviceApplicationError.js'

export { DomainError, databaseReadFailure, retryDatabaseRead } from '@foreman-code/contracts-node/server-kit'

/** The `class` a public HTTP or MCP error reply adds, so a retryable failure is not read as final. Omitted when
 * the error already states `details.retryable` or is permanent. */
export function publicFailureClass(error: unknown): FailureClass | undefined {
  if (error instanceof DomainError && typeof error.details?.retryable === 'boolean') return undefined
  const failure = deviceApplicationFailure(error)
  return failure.class === 'permanent' ? undefined : failure.class
}

/** Pool timeouts and server admission failures happen before a connection can run the request. */
export function databaseConnectionFailure(error: unknown): unknown {
  if (error instanceof DomainError) return error
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  if (!isDatabasePoolTimeout(error) && code !== '53300' && code !== '57P03') return error
  return new DomainError('DATABASE_BUSY',
    'A database connection is temporarily unavailable. Retry shortly with the same commandId if supplied.',
    503, { retryable: true, newCommandRequired: false }, { cause: error })
}

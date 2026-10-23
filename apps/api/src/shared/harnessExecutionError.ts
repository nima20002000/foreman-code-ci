import type { ExecutionResult } from '@foreman-code/contracts'
import { isTransientExecutionCode } from './executionFailureCodes.js'

export class HarnessExecutionError extends Error {
  readonly result: ExecutionResult

  constructor(code: string, message: string, retryable = isTransientExecutionCode(code), options?: ErrorOptions) {
    super(message, options)
    this.name = 'HarnessExecutionError'
    this.result = { outcome: 'failed', error: { code, message, retryable } }
  }
}

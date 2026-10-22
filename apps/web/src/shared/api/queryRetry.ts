import { ApiError } from './client'

/** Reads retry a failure that the next attempt can fix (no response, a 5xx, a timeout, rate limiting) twice
 * before a surface shows its error. Without this, every brief network or link drop flipped a page into its
 * error state and back on the next poll. Answers such as denied, not found or invalid are final at once. */
export function retryTransientRead(failureCount: number, error: unknown): boolean {
  if (failureCount >= 2 || !ApiError.is(error)) return false
  return error.code === 'NETWORK_ERROR' || error.status >= 500 || error.status === 408 || error.status === 429
}

/** A command that carries a commandId replays on the server instead of applying twice, so it retries the same
 * transient failures with the same input (and so the same commandId) before showing an error. */
export const retryTransientCommand = retryTransientRead

export function transientRetryDelay(attempt: number): number {
  return attempt === 0 ? 1_000 : 3_000
}

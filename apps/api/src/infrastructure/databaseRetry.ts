/**
 * The API's database retry policies, in one place. Pick by what is being retried:
 *
 * | Helper | Retries | Policy |
 * |---|---|---|
 * | `retryDatabaseRead` (`@foreman-code/contracts-node/server-kit`, shared with CI) | idempotent read; lock/statement timeout | 3 attempts, no wait; a persistent timeout becomes DATABASE_READ_TIMEOUT |
 * | `retryDatabaseTimeout` | replay-safe bookkeeping; statement/lock/query timeout | backoff 100 ms doubling to 1 s, 30 s deadline (or `timeoutMs`) |
 * | `retryDatabaseOperation` | replay-safe work; caller-chosen classifier | same backoff and deadline as above |
 * | `retryStartupDatabase` | one replay-safe startup step; timeout or lost/refused connection | same backoff and deadline as above |
 * | `withDatabaseReadRetry` + `acquireDatabaseConnection` | pool acquisition inside a read-only request | one retry after 50 ms per request |
 *
 * Read-only MCP tools enter `withDatabaseReadRetry` through `mcp/shared/databaseReadRetry.ts`.
 * Writes that cannot be replayed (native submissions, commits with unknown outcome) never enter any of these.
 * The CI host keeps its own read retry (`apps/ci/src/readQueries.ts`).
 */
import { AsyncLocalStorage } from 'node:async_hooks'
import { setTimeout as delay } from 'node:timers/promises'
import { componentLogger } from './logger.js'

import { isDatabasePoolTimeout, isDatabaseTimeout, isTransientDatabaseOrSocketError } from '@foreman-code/contracts/failure'
export { isDatabasePoolTimeout, isDatabaseTimeout }

export interface DatabaseRetryOptions {
  signal?: AbortSignal | undefined
  check?(): void
  timeoutMs?: number
}

/** Retry only replay-safe bookkeeping. Native submissions are never passed here. */
export function retryDatabaseTimeout<T>(work: () => Promise<T>, options: DatabaseRetryOptions = {}): Promise<T> {
  return retryDatabaseOperation(work, isDatabaseTimeout, options)
}

export async function retryDatabaseOperation<T>(
  work: () => Promise<T>,
  isRetryable: (error: unknown) => boolean,
  options: DatabaseRetryOptions = {},
): Promise<T> {
  let waitMs = 100
  const startedAt = Date.now()
  const timeoutMs = options.timeoutMs ?? 30_000
  if (!Number.isFinite(timeoutMs) || timeoutMs <= 0) throw new Error('Database retry timeout must be positive.')
  let attempt = 0
  for (;;) {
    options.signal?.throwIfAborted()
    options.check?.()
    try {
      const result = await work()
      options.signal?.throwIfAborted()
      options.check?.()
      return result
    } catch (error) {
      options.signal?.throwIfAborted()
      options.check?.()
      if (!isRetryable(error)) throw error
      attempt += 1
      const elapsedMs = Date.now() - startedAt
      componentLogger('engine').warn({ operation: 'retry database operation', err: error, attempt, elapsedMs,
        nextRetryMs: Math.min(waitMs, Math.max(0, timeoutMs - elapsedMs)) },
      'Database operation is temporarily unavailable; retrying.')
      if (elapsedMs >= timeoutMs) {
        throw Object.assign(new Error('Database operation retry deadline exceeded.', { cause: error }),
          { code: 'DATABASE_RETRY_DEADLINE_EXCEEDED', attempts: attempt, elapsedMs })
      }
      await delay(Math.min(waitMs, timeoutMs - elapsedMs), undefined, { signal: options.signal })
      waitMs = Math.min(1_000, waitMs * 2)
    }
  }
}

const transientConnectionCodes = new Set([
  'ECONNREFUSED', 'ECONNRESET', 'EPIPE', 'ETIMEDOUT', 'EAI_AGAIN',
  '08000', '08001', '08003', '08006',
  '57P01', '57P02', '57P03', '53300',
])

function isTransientStartupDatabaseError(error: unknown): boolean {
  if (isDatabaseTimeout(error)) return true
  const seen = new Set<object>()
  while (error && typeof error === 'object' && !seen.has(error)) {
    seen.add(error)
    const code = 'code' in error ? error.code : undefined
    if (code !== undefined && code !== 'GRAPH_TRANSACTION_FAILED') {
      return typeof code === 'string' && transientConnectionCodes.has(code)
    }
    if (isDatabasePoolTimeout(error)) return true
    if (error instanceof Error && error.message === 'Connection terminated unexpectedly') return true
    error = 'cause' in error ? error.cause : undefined
  }
  return false
}

/** Each operation must be replay-safe; initialization also registers routes and cannot be retried as a whole. */
export function retryStartupDatabase<T>(
  work: () => Promise<T>,
  options: DatabaseRetryOptions = {},
): Promise<T> {
  return retryDatabaseOperation(work, isTransientStartupDatabaseError, options)
}

/** First pass of a background loop that also runs on a timer: a transient database or socket failure is reported and
 * left to the next tick; anything else still fails startup. */
export async function runBackgroundPassAtStartup(pass: () => Promise<void>, report: (error: unknown) => void): Promise<void> {
  try { await pass() } catch (error) {
    if (!isTransientDatabaseOrSocketError(error)) throw error
    report(error)
  }
}

const reads = new AsyncLocalStorage<{ retried: boolean; signal?: AbortSignal | undefined }>()

/** One acquisition retry per read, including tools whose handlers format their own errors. */
export function withDatabaseReadRetry<T>(work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
  return reads.run({ retried: false, signal }, work)
}

export async function acquireDatabaseConnection<T>(acquire: () => Promise<T>): Promise<T> {
  const read = reads.getStore()
  read?.signal?.throwIfAborted()
  try {
    return await acquire()
  } catch (error) {
    if (!read || read.retried || !isDatabasePoolTimeout(error)) throw error
    read.signal?.throwIfAborted()
    read.retried = true
    await delay(50, undefined, { signal: read.signal })
    return acquire()
  }
}

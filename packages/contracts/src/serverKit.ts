// Node-only server helpers shared by the API and CI packages. Plain fields, not parameter properties: Worker code
// loads this file through Node's type stripping.

// The browser native host is bundled separately and has its own copy of this class; the brand lets both copies
// recognise each other's errors, so its codes and messages reach callers instead of a generic internal error.
const domainErrorBrand = Symbol.for('foreman-code.DomainError')

export class DomainError extends Error {
  static [Symbol.hasInstance](value: unknown): boolean {
    if (this !== DomainError) return Function.prototype[Symbol.hasInstance].call(this, value)
    return typeof value === 'object' && value !== null && (value as { [domainErrorBrand]?: unknown })[domainErrorBrand] === true
  }
  readonly code: string
  readonly status: number
  readonly details?: Record<string, unknown> | undefined
  // Transport handlers reuse a denial already recorded by the domain service.
  denialAudited = false

  constructor(code: string, message: string, status: number, details?: Record<string, unknown>, options?: ErrorOptions) {
    super(message, options)
    this.code = code
    this.status = status
    this.details = details
    this.name = 'DomainError'
    Object.defineProperty(this, domainErrorBrand, { value: true })
  }
}

/** Safe read retries never expose database statements or persisted payloads. */
export function databaseReadFailure(error: unknown): unknown {
  if (error instanceof DomainError) return error
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  const readTimeout = error instanceof Error && error.message === 'Query read timeout'
  if (code !== '57014' && code !== '55P03' && !readTimeout) return error
  const failure = new DomainError('DATABASE_READ_TIMEOUT',
    'The database read exceeded its deadline. Retry the request.', 503, {
      retryable: true,
      reason: readTimeout ? 'query_read_timeout' : code === '55P03' ? 'lock_timeout' : 'query_canceled',
      ...(readTimeout ? {} : { sqlState: code }),
    })
  failure.cause = error
  return failure
}

/** Replays an idempotent read after a lock or statement timeout; a timeout that persists becomes DATABASE_READ_TIMEOUT. */
export async function retryDatabaseRead<T>(read: () => Promise<T>, attempts = 3): Promise<T> {
  for (let attempt = 1; ; attempt += 1) {
    try {
      return await read()
    } catch (error) {
      const failure = databaseReadFailure(error)
      if (failure === error || attempt >= attempts) throw failure
    }
  }
}

export function errorMessage(error: unknown, fallback: string): string {
  return error instanceof Error ? error.message : fallback
}

/** A failed background operation waits before another attempt; success starts a fresh retry sequence. */
export class RetryBackoff {
  private readonly delays: { initialMs: number; maxMs: number }
  private failures = 0
  private nextAttemptAt = 0

  constructor(delays: { initialMs: number; maxMs: number }) {
    this.delays = delays
  }

  ready(now = Date.now()): boolean {
    return now >= this.nextAttemptAt
  }

  fail(now = Date.now()): number {
    const delay = Math.min(this.delays.maxMs, this.delays.initialMs * 2 ** Math.min(this.failures, 30))
    this.failures++
    this.nextAttemptAt = now + delay
    return delay
  }

  reset(): void {
    this.failures = 0
    this.nextAttemptAt = 0
  }
}

/** Runs `file` under a detached supervisor that outlives the API with the deadline (and any lock descriptors the
 * command inherits). `timeout` runs the command in its own process group and stops it at expiry; whenever it ends, or
 * the caller sends SIGTERM, every process left in that group is killed so none keeps those descriptors. */
export function underDeadline(timeoutMs: number, file: string, args: readonly string[]): [string, string[]] {
  return ['/bin/sh', ['-c', 'trap \'kill -KILL -$! $! 2>/dev/null; exit 143\' TERM; '
    + 'timeout --signal=TERM --kill-after=0.25s "$@" & wait $!; status=$?; kill -KILL -$! 2>/dev/null; exit $status',
  'deadline', `${timeoutMs / 1000}s`, file, ...args]]
}

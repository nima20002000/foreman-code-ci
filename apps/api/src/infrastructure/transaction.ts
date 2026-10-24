import type pg from 'pg'
import { retryDatabaseTimeout } from './databaseRetry.js'
import { databaseDomainError } from './databaseErrors.js'
import { componentLogger } from './logger.js'
import { timeRuntimeOperation } from './runtimeTiming.js'

/**
 * The one module that issues transaction-control statements. Everything else runs a transaction through
 * withTransaction. Connection-loss and commit-outcome handling goes through its `rollback` option, and the one
 * session that must keep a transaction open across its own callbacks (commands/postgres.ts) uses TransactionSession.
 * Run-graph sessions run through ExclusiveGraphConnection (modules/run-graph/connection.ts), whose
 * `transaction` calls withTransaction and adds statement queueing, a statement guard, before-commit checks and
 * poisoning around it.
 */

/** Minimal SQL port: a Pool, a client or a graph transaction all satisfy it. */
export interface SqlQuery {
  query<R extends pg.QueryResultRow = pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>>
}
/** An open run-graph transaction: the guarded port ExclusiveGraphConnection.transaction hands to its callback. */
export interface SqlTransaction extends SqlQuery { readonly transaction: true }
/**
 * A session that can hold transaction-scoped locks: a checked-out client or a graph transaction.
 * A bare Pool never satisfies it, so lock-taking helpers cannot run each statement on a different connection.
 */
export type TransactionSql = SqlQuery & ({ release(err?: Error | boolean): void } | SqlTransaction)

export interface TransactionOptions {
  isolation?: 'read committed' | 'repeatable read'
  readOnly?: boolean
  /** Extra whole-transaction attempts after a serialization failure or deadlock. Only for replay-safe callbacks. */
  conflictRetries?: number
  operation?: TransactionOperation
}

export type TransactionOperation = 'transaction' | 'graph.read' | 'graph.write'
type TransactionOutcome = 'committed' | 'rolled_back' | 'failed'
const transactionTimings = new WeakMap<pg.ClientBase, { timing: TransactionTiming; restore: () => void }>()

function beginStatement(options: TransactionOptions): string {
  return ['begin', options.isolation && `isolation level ${options.isolation}`, options.readOnly && 'read only']
    .filter(Boolean).join(' ')
}

/**
 * Statement primitives under withTransaction and TransactionSession. Production code does not call them; they stay
 * exported for integration tests that hold a transaction open on their own connection to provoke lock contention.
 */
export async function beginTransaction(client: pg.ClientBase, options: TransactionOptions = {},
  origin = new Error('transaction caller')): Promise<void> {
  const timing = new TransactionTiming(origin, options.operation)
  transactionTimings.set(client, { timing, restore: timeClientStatements(client, timing) })
  try {
    await client.query(beginStatement(options))
  } catch (error) {
    finishTransactionTiming(client, 'failed')
    throw error
  }
}

export async function commitTransaction(client: pg.ClientBase): Promise<void> {
  await client.query('commit')
  finishTransactionTiming(client, 'committed')
}

export async function rollbackTransaction(client: pg.ClientBase): Promise<void> {
  try {
    await client.query('rollback')
    finishTransactionTiming(client, 'rolled_back')
  } catch (error) {
    finishTransactionTiming(client, 'failed')
    throw error
  }
}

/** End instrumentation when a connection closes before transaction control can finish. */
function finishTransactionTiming(client: pg.ClientBase, outcome: TransactionOutcome): void {
  const active = transactionTimings.get(client)
  if (!active) return
  transactionTimings.delete(client)
  active.restore()
  active.timing.finish(outcome)
}

/**
 * Rolls back after a failure without replacing the caller's error. Returns the rollback error, already logged,
 * when the session state is unknown: the caller must then discard the connection.
 */
export async function rollbackAfterFailure(client: pg.ClientBase): Promise<Error | undefined> {
  try {
    await rollbackTransaction(client)
    return undefined
  } catch (rollbackError) {
    componentLogger('db').error({ operation: 'transaction rollback', err: rollbackError },
      'Transaction rollback failed; discarding its connection')
    return rollbackError instanceof Error ? rollbackError : new Error('Transaction rollback failed.')
  }
}

/** A transaction that holds its locks longer than this is reported with where its time went. */
const SLOW_TRANSACTION_MS = 1_000

/**
 * Times one transaction: statements versus the gaps between them, where the application awaited other work while
 * the transaction kept its locks. `origin` is created where the transaction was requested, so the report names
 * the caller even when the work runs from a queue.
 */
export class TransactionTiming {
  readonly #started = performance.now()
  #lastEnd = this.#started
  #queryMs = 0
  #queries = 0
  #largestGapMs = 0
  #running = 0
  readonly #operation: TransactionOperation
  constructor(private readonly origin: Error, operation: TransactionOperation = 'transaction') {
    this.#operation = operation === 'graph.read' || operation === 'graph.write' ? operation : 'transaction'
  }

  track<T>(statement: Promise<T>): Promise<T> {
    const started = performance.now()
    if (this.#running === 0) this.#largestGapMs = Math.max(this.#largestGapMs, started - this.#lastEnd)
    this.#running += 1
    this.#queries += 1
    const settle = () => {
      this.#running -= 1
      this.#lastEnd = performance.now()
      this.#queryMs += this.#lastEnd - started
    }
    return statement.then(result => { settle(); return result }, (error: unknown) => { settle(); throw error })
  }

  finish(outcome: TransactionOutcome): void {
    componentLogger('db').info({ metric: 'db_transaction_statements', operation: this.#operation,
      outcome, statements: this.#queries }, 'Database transaction statements')
    const finished = performance.now(), totalMs = finished - this.#started
    if (totalMs <= SLOW_TRANSACTION_MS) return
    const queryMs = Math.min(this.#queryMs, totalMs)
    componentLogger('db').warn({ caller: transactionCaller(this.origin), totalMs: Math.round(totalMs),
      queryMs: Math.round(queryMs), betweenQueriesMs: Math.round(totalMs - queryMs), queries: this.#queries,
      largestGapMs: Math.round(Math.max(this.#largestGapMs, finished - this.#lastEnd)) }, 'Slow database transaction')
  }
}

/** The first application frames above the transaction helpers. */
function transactionCaller(origin: Error): string {
  return (origin.stack ?? '').split('\n').slice(1).map(line => line.trim().replace(/^at /, ''))
    .filter(line => !/infrastructure\/transaction\.|run-graph\/connection\.|node:internal|node_modules|<anonymous>/.test(line))
    .slice(0, 3).map(line => line.replace(/(?:file:\/\/)?\/\S*?\/(?=(?:src|dist|test)\/)/, '')).join(' < ')
}

/** Times every statement the transaction sends through its own client until the returned restore is called. */
function timeClientStatements(client: pg.ClientBase, timing: TransactionTiming): () => void {
  const own = Object.prototype.hasOwnProperty.call(client, 'query')
  const original = client.query
  const timed = (...args: unknown[]) => {
    try {
      const result: unknown = Reflect.apply(original, client, args)
      if (result instanceof Promise) return timing.track(result)
      void timing.track(Promise.resolve(result))
      return result
    } catch (error) {
      return timing.track(Promise.reject(error))
    }
  }
  client.query = timed as unknown as typeof client.query
  return () => {
    if (own) client.query = original
    else delete (client as { query?: unknown }).query
  }
}

export function isTransactionConflict(error: unknown): boolean {
  const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined
  return code === '40001' || code === '40P01'
}

/** Where a transaction runs: a fresh connection from a pool, or a connection the caller owns, keeps and releases. */
export type TransactionSource = Pick<pg.Pool, 'connect'> | { readonly client: pg.ClientBase }

/** Where a failed transaction was when it failed: sending BEGIN, running the callback, or sending COMMIT. */
export type TransactionPhase = 'begin' | 'work' | 'commit'

export interface TransactionRunOptions extends TransactionOptions {
  /**
   * The caller's open transaction, when it has one: perform runs on it directly and the caller commits or rolls
   * back, so the other options do not apply. Undefined starts a transaction from the source as usual.
   */
  join?: pg.ClientBase | undefined
  /** Where the transaction was requested, for slow-transaction reports of work that runs later from a queue. */
  origin?: Error
  /** Publish `sql.begin` and `sql.commit` runtime-timing records for this transaction. */
  runtimeTiming?: boolean
  /**
   * Replaces the rollback that follows a failure, for a session that decides from the failed phase whether its
   * connection is still usable or that must recover a stalled rollback (rollbackWithRecovery). Return the error
   * when the session state is unknown, so the connection is discarded; the original error is still thrown. With
   * it, a failed BEGIN is rolled back too.
   */
  rollback?: (client: pg.ClientBase, failure: { error: unknown; phase: TransactionPhase }) => Promise<Error | undefined>
}

type Attempt<T> = { ok: true; value: T } | { ok: false; error: unknown; rollbackError: Error | undefined }

async function attempt<T>(client: pg.PoolClient, perform: (client: pg.PoolClient) => Promise<T>,
  options: TransactionRunOptions, origin: Error, rollbackFailedBegin: boolean): Promise<Attempt<T>> {
  const timed = <R>(phase: string, work: () => Promise<R>) =>
    options.runtimeTiming ? timeRuntimeOperation('db', phase, work) : work()
  let phase: TransactionPhase = 'begin'
  try {
    await timed('sql.begin', () => beginTransaction(client, options, origin))
    phase = 'work'
    const value = await perform(client)
    phase = 'commit'
    await timed('sql.commit', () => commitTransaction(client))
    return { ok: true, value }
  } catch (error) {
    if (phase === 'begin' && !rollbackFailedBegin) throw error
    const rollbackError = await (options.rollback ?? rollbackAfterFailure)(client, { error, phase })
    if (rollbackError) finishTransactionTiming(client, 'failed')
    return { ok: false, error, rollbackError }
  }
}

/**
 * The one way to run a transaction. Commit on success; on any error roll back and rethrow the original error.
 * - From a pool: a fresh connection, released always and destroyed when rollback fails.
 * - From `{ client }`: a connection the caller owns and releases; a failed BEGIN is not rolled back, and a failed
 *   rollback is logged.
 * - With `join`: inside the caller's transaction (see TransactionRunOptions.join).
 * `conflictRetries` repeats the whole transaction after a serialization failure or deadlock.
 */
export function withTransaction<T>(pool: Pick<pg.Pool, 'connect'>, perform: (client: pg.PoolClient) => Promise<T>,
  options?: TransactionOptions): Promise<T>
export function withTransaction<T>(source: TransactionSource, perform: (client: pg.ClientBase) => Promise<T>,
  options?: TransactionRunOptions): Promise<T>
export async function withTransaction<T>(
  source: TransactionSource,
  perform: (client: pg.PoolClient) => Promise<T>,
  options: TransactionRunOptions = {},
): Promise<T> {
  if (options.join) return perform(options.join as pg.PoolClient)
  const origin = options.origin ?? new Error('transaction caller')
  const retries = options.conflictRetries ?? 0
  if ('client' in source) {
    const client = source.client as pg.PoolClient
    for (let tries = 0; ; tries += 1) {
      const result = await attempt(client, perform, options, origin, options.rollback !== undefined)
      if (result.ok) return result.value
      if (result.rollbackError || tries >= retries || !isTransactionConflict(result.error)) throw databaseDomainError(result.error)
    }
  }
  for (let tries = 0; ; tries += 1) {
    const client = await source.connect()
    let releaseError: Error | undefined
    try {
      const result = await attempt(client, perform, options, origin, true)
      if (result.ok) return result.value
      releaseError = result.rollbackError
      if (releaseError || tries >= retries || !isTransactionConflict(result.error)) throw databaseDomainError(result.error)
    } finally {
      client.release(releaseError)
    }
  }
}

/**
 * Rollback for a session whose queries may be stalled: retries a timed-out rollback until the closing signal or
 * five seconds, so a confirmed rollback restores the connection. Pass it from a `rollback` option.
 */
export async function rollbackWithRecovery(client: pg.ClientBase, closing: AbortSignal): Promise<void> {
  const deadline = new AbortController()
  const timer = setTimeout(() => deadline.abort(new Error('Graph rollback recovery timed out.')), 5_000)
  timer.unref()
  const signal = AbortSignal.any([closing, deadline.signal])
  let onAbort: (() => void) | undefined
  try {
    signal.throwIfAborted()
    const canceled = new Promise<never>((_resolve, reject) => {
      onAbort = () => reject(signal.reason)
      signal.addEventListener('abort', onAbort, { once: true })
    })
    await Promise.race([
      retryDatabaseTimeout(() => timeRuntimeOperation('db', 'sql.rollback', () => rollbackTransaction(client)), { signal }),
      canceled,
    ])
  } finally {
    clearTimeout(timer)
    if (onAbort) signal.removeEventListener('abort', onAbort)
  }
}

/**
 * One connection's transactions driven by hand, for the one session that must keep a transaction open across its
 * own callbacks and decide at each step whether to commit, roll back or begin again (commands/postgres.ts). Every
 * other caller uses withTransaction. `open` is true from a successful begin until a successful commit or rollback.
 */
export class TransactionSession {
  #open = false
  constructor(private readonly client: pg.ClientBase) {}
  get open(): boolean { return this.#open }
  async begin(options: TransactionOptions = {}): Promise<void> {
    await beginTransaction(this.client, options)
    this.#open = true
  }
  async commit(): Promise<void> {
    await commitTransaction(this.client)
    this.#open = false
  }
  async rollback(): Promise<void> {
    await rollbackTransaction(this.client)
    this.#open = false
  }
}

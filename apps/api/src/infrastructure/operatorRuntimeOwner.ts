import pg from 'pg'
import { DomainError } from '../modules/errors.js'
import { retryStartupDatabase } from './startupDatabase.js'
import { isDatabaseTimeout, retryDatabaseOperation } from './databaseTimeout.js'
import { withAbortSignal } from './abortSignal.js'

const ownershipRetryMs = 30_000

function isRuntimeDatabaseTimeout(error: unknown): error is DomainError {
  return error instanceof DomainError && error.code === 'NATIVE_RUNTIME_DATABASE_TIMEOUT'
}

/** One API/native owner per database. A separate connection never consumes an application-pool slot. */
export class OperatorRuntimeOwner {
  private client: pg.Client
  private readonly startup = new AbortController()
  private held = false
  private closing = false
  private loss: Error | undefined
  private acquisition: Promise<void> | undefined
  private closure: Promise<void> | undefined
  private ending: Promise<void> | undefined
  private transportDeadline: ReturnType<typeof setTimeout> | undefined

  constructor(private readonly connectionString: string, private readonly onLost: (error: Error) => void) {
    this.client = this.createClient()
  }

  private createClient(): pg.Client {
    const client = new pg.Client({
      connectionString: this.connectionString,
      connectionTimeoutMillis: 5_000,
      statement_timeout: 4_000,
      query_timeout: 6_000,
    })
    const lost = (error: Error) => {
      if (client === this.client) this.loseOwnership(error)
    }
    client.on('error', lost)
    client.on('end', () => lost(new Error('The native runtime ownership connection ended.')))
    return client
  }

  /** Passive authority for local telemetry; no lock acquisition or owner mutation. */
  get active(): boolean { return this.held && !this.closing && !this.loss }
  async readRuntimeEpoch(options: { signal?: AbortSignal | undefined } = {}): Promise<string> {
    const signal = options.signal ? AbortSignal.any([this.startup.signal, options.signal]) : this.startup.signal
    const assertActive = () => {
      if (!this.active) throw new DomainError('NATIVE_RUNTIME_UNAVAILABLE', 'The original runtime owner is not active.', 503)
    }
    // The advisory lock lasts for the session; an epoch read timeout does not release ownership.
    const result = await retryDatabaseOperation(() => withAbortSignal(() => this.queryWithDeadline<{ epoch: string }>(`
      select (extract(epoch from backend_start)*1000000)::bigint::text as epoch
      from pg_stat_activity where pid=pg_backend_pid()`), signal), isRuntimeDatabaseTimeout, {
      signal,
      check: assertActive,
      timeoutMs: ownershipRetryMs,
    })
    const row = result.rows[0]
    if (!this.active || !row?.epoch) throw new DomainError('NATIVE_RUNTIME_UNAVAILABLE', 'The original runtime owner epoch is unavailable.', 503)
    return row.epoch
  }

  acquire(): Promise<void> {
    if (this.closing) return Promise.reject(new Error('Native runtime ownership is closing.'))
    if (this.loss) return Promise.reject(this.loss)
    this.acquisition ??= Promise.resolve().then(() => retryStartupDatabase(async () => {
      if (this.ending) {
        await this.ending
        this.ending = undefined
        this.loss = undefined
        this.client = this.createClient()
      }
      try {
        await this.client.connect()
        if (this.closing) throw new Error('Native runtime ownership is closing.')
        const result = await this.query<{ acquired: boolean }>('select pg_try_advisory_lock($1) as acquired', [710_014])
        if (!result.rows[0]?.acquired) {
          throw new DomainError('OPERATOR_API_ALREADY_OWNED', 'Another API process owns the native runtime for this database. Multi-instance native execution is not enabled.', 503)
        }
        if (this.loss) throw this.loss
        this.held = true
      } catch (error) {
        // No protected work is admitted until acquisition succeeds.
        try { await this.end() } catch (cleanupError) {
          throw new AggregateError([error, cleanupError], 'Native runtime ownership acquisition cleanup failed.', { cause: cleanupError })
        }
        throw error
      }
    }, { signal: this.startup.signal })).catch(error => {
      // A late lock result still belongs to close(), which waits before unlocking it.
      if (this.closing && this.held && this.startup.signal.aborted) return
      throw error
    })
    return this.acquisition
  }

  /** Call only AFTER successful protected cleanup, never in a cleanup finally block. */
  close(): Promise<void> {
    this.closing = true
    this.confirmTransport()
    this.startup.abort(new Error('Native runtime ownership is closing.'))
    this.closure ??= Promise.resolve().then(async () => {
      // A shutdown during connect must not leave a late-acquired lock behind.
      if (!this.acquisition) return
      // The acquisition caller reports startup errors; release only waits for its connection cleanup.
      await this.acquisition.then(() => undefined, () => undefined)
      try {
        if (this.held) await this.query('select pg_advisory_unlock($1)', [710_014])
      } finally {
        this.held = false
        await this.end()
      }
    })
    return this.closure
  }

  private end(): Promise<void> {
    this.ending ??= Promise.resolve().then(async () => {
      let timer: ReturnType<typeof setTimeout> | undefined
      try {
        await Promise.race([this.client.end(), new Promise<never>((_resolve, reject) => {
          timer = setTimeout(() => {
            this.destroySession()
            reject(new Error('The runtime ownership connection did not close within its deadline.'))
          }, 1_000)
        })])
      } finally {
        if (timer) clearTimeout(timer)
      }
    })
    return this.ending
  }

  private destroySession(): void {
    const connection = (this.client as pg.Client & {
      connection?: { stream?: { destroy(): void } }
    }).connection
    connection?.stream?.destroy()
  }

  private loseOwnership(error: Error): void {
    if (this.ending || this.loss) return
    this.confirmTransport()
    this.loss = error
    const held = this.held
    this.held = false
    if (held && !this.closing) this.onLost(error)
  }

  private confirmTransport(): void {
    clearTimeout(this.transportDeadline)
    this.transportDeadline = undefined
  }

  private watchTransport(): void {
    if (!this.active || this.transportDeadline) return
    // This window survives read cancellation and subsequent callers' retry budgets.
    this.transportDeadline = setTimeout(() => {
      this.loseOwnership(new DomainError('NATIVE_RUNTIME_UNAVAILABLE',
        'The runtime ownership connection could not be confirmed within its deadline.', 503))
      this.destroySession()
    }, ownershipRetryMs)
    this.transportDeadline.unref()
  }

  private async query<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    try {
      return await this.queryWithDeadline<R>(text, values)
    } catch (error) {
      if (!isRuntimeDatabaseTimeout(error)) throw error
      this.loseOwnership(error)
      // An unanswered lock request may have acquired ownership on the server.
      this.destroySession()
      await this.end()
      throw error
    }
  }

  private async queryWithDeadline<R extends pg.QueryResultRow>(text: string, values?: unknown[]): Promise<pg.QueryResult<R>> {
    const timeout = new DomainError('NATIVE_RUNTIME_DATABASE_TIMEOUT',
      'The runtime ownership database did not respond within its deadline.', 503)
    let timer: ReturnType<typeof setTimeout> | undefined
    try {
      const deadline = new Promise<never>((_resolve, reject) => {
        timer = setTimeout(() => reject(timeout), 5_000)
      })
      const response = this.client.query<R>(text, values).then(result => {
        this.confirmTransport()
        return result
      }, (error: unknown) => {
        // A server cancellation reply confirms that the original session is still reachable.
        if (error && typeof error === 'object' && 'code' in error && error.code === '57014') {
          this.confirmTransport()
        }
        throw error
      })
      return await Promise.race([response, deadline])
    } catch (error) {
      if (error === timeout || isDatabaseTimeout(error)) {
        const serverTimeout = error && typeof error === 'object' && 'code' in error && error.code === '57014'
        if (!serverTimeout) this.watchTransport()
        throw timeout
      }
      throw error
    } finally {
      if (timer) clearTimeout(timer)
    }
  }
}

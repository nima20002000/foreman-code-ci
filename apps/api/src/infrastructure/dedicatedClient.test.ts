import { describe, expect, it, vi } from 'vitest'
import { ownedTestDatabaseUrl } from '../../test/helpers/testResources.js'
import { isDatabasePoolTimeout } from './databaseRetry.js'
import { withDedicatedClient } from './pool.js'

/** Holds the thread, like a host whose busy thread pool delays the connection handshake past its deadline. */
const stall = (milliseconds: number) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, milliseconds)

describe('dedicated database connections', () => {
  it('report a connect timeout as a connection timeout that callers retry', async () => {
    const work = vi.fn()
    // The 1 ms connect deadline starts with the connection; the stall lets it expire before the handshake completes.
    const connecting = withDedicatedClient({ connectionString: ownedTestDatabaseUrl(), connectionTimeoutMillis: 1 },
      'dedicated-timeout-test', work).catch((error: unknown) => error)
    stall(20)
    const failure = await connecting
    expect(work).not.toHaveBeenCalled()
    expect(failure).toBeInstanceOf(Error)
    expect(isDatabasePoolTimeout(failure)).toBe(true)
  })
})

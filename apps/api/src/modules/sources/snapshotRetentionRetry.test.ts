import type pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { releaseUnusedSourceSnapshots } from './snapshotRetention.js'
import type { PrivateSourceSnapshotStore } from './store.js'

const store: Pick<PrivateSourceSnapshotStore, 'remove' | 'withCaptureLock'> = {
  remove: async () => { throw new Error('Unexpected snapshot deletion') },
  withCaptureLock: async (_id, work) => work(),
}
afterEach(() => vi.useRealTimers())

it('reports failed maintenance scans without aborting reconciliation and backs off repeated scans', async () => {
  vi.useFakeTimers({ toFake: ['Date'] })
  const error = Object.assign(new Error('canceling statement due to statement timeout'), { code: '57014' })
  const query = vi.fn().mockRejectedValue(error)
  const pool = { query } as unknown as pg.Pool
  const report = vi.fn()
  await expect(releaseUnusedSourceSnapshots(pool, store, 'storage-scope', report)).resolves.toBeUndefined()
  expect(report).toHaveBeenCalledExactlyOnceWith(error)
  for (let attempt = 1; attempt <= 5; attempt++) {
    vi.setSystemTime(Date.now() + Math.min(60 * 60_000, 10 * 60_000 * 2 ** (attempt - 1)) - 1)
    await releaseUnusedSourceSnapshots(pool, store, 'storage-scope', report)
    expect(query).toHaveBeenCalledTimes(attempt)
    vi.setSystemTime(Date.now() + 1)
    await releaseUnusedSourceSnapshots(pool, store, 'storage-scope', report)
    expect(query).toHaveBeenCalledTimes(attempt + 1)
    expect(report).toHaveBeenCalledTimes(attempt + 1)
  }
  // Capacity-driven scans must still attempt reclamation and report their own failures.
  await expect(releaseUnusedSourceSnapshots(pool, store, 'storage-scope', undefined, true)).rejects.toBe(error)
  expect(query).toHaveBeenCalledTimes(7)
})

import { expect, it, vi } from 'vitest'
import { BrowserProfileRetention } from './retention.js'
import { DomainError } from '../errors.js'
import type { BrowserProfileHost, BrowserProfileRepository, BrowserProfileTransaction } from './types.js'

function fixture() {
  const clearRetention = vi.fn(async () => undefined)
  const tx = { retention: async () => ({ snapshots: [], operations: [], computers: ['gone', 'paired'], revision: 7 }), clearRetention } as unknown as BrowserProfileTransaction
  const repository = { read: work => work(tx), transaction: (_locks, work) => work(tx) } as BrowserProfileRepository
  const host = { prune: vi.fn(async (input: { computerId: string }) => {
    if (input.computerId === 'gone') throw new DomainError('BROWSER_PAIRING_CHANGED', 'This computer is no longer paired.', 403)
  }) } as unknown as BrowserProfileHost
  const retention = new BrowserProfileRetention(repository, { prune: async () => [] } as never, { prune: async () => undefined } as never, host)
  return { retention, host, clearRetention }
}

it('prunes the remaining computers and settles the receipt when one referenced computer was unpaired', async () => {
  const f = fixture()
  await f.retention.reconcile('profile')
  expect(vi.mocked(f.host.prune).mock.calls.map(([input]) => input.computerId)).toEqual(['gone', 'paired'])
  expect(f.clearRetention).toHaveBeenCalledWith('profile', 7)
})

it('still prunes later computers after a transient failure, keeps the receipt for retry and surfaces the error', async () => {
  const f = fixture()
  vi.mocked(f.host.prune).mockImplementation(async input => { if (input.computerId === 'gone') throw new Error('transport down') })
  await expect(f.retention.reconcile('profile')).rejects.toThrow('transport down')
  expect(vi.mocked(f.host.prune).mock.calls.map(([input]) => input.computerId)).toEqual(['gone', 'paired'])
  expect(f.clearRetention).not.toHaveBeenCalled()
})

import pg from 'pg'
import { afterEach, expect, it, vi } from 'vitest'
import { MainBrowserPairing } from './browserPairing.js'
import { profileWorkFixture } from '../browser-profiles/work.test-support.js'
import { reconcileBrowserProfileIntent } from '../browser-profiles/reconcile.js'
import { admitBrowserProfileSync, BrowserProfileSyncCoordinator } from '../browser-profiles/sync.js'
import type { BrowserInstallationBinding } from '../browser-profiles/keys.js'

const pools: pg.Pool[] = []
afterEach(async () => {
  vi.restoreAllMocks()
  await Promise.all(pools.splice(0).map(pool => pool.end()))
})

function pairingFixture() {
  const pool = new pg.Pool(); pools.push(pool)
  const bindings = new Map<string, BrowserInstallationBinding>(['source', 'worker'].map(computerId => [computerId,
    { computerId, installationId: `${computerId}-installation`, connectionId: 'original' }]))
  const pairing = new MainBrowserPairing(pool, () => 'main', () => null)
  // Installed connection facts are supplied by the pairing/transport owner.
  vi.spyOn(pairing, 'current').mockImplementation(async computerId => ({ ...bindings.get(computerId)! }))
  return { pairing, bindings }
}

it.each(['export', 'receive', 'apply'] as const)('retries the admitted %s after its paired connection changes', async operation => {
  const f = profileWorkFixture(), { pairing, bindings } = pairingFixture()
  const profile = (await f.service.create(f.owner, { name: 'Profile', computerId: 'source' })).value
  await reconcileBrowserProfileIntent(f.service, (await f.service.get(f.owner, profile.id)).operations[0]!.id)
  const computerId = operation === 'export' ? 'source' : 'worker'
  const original = await pairing.current(computerId)
  vi.mocked(f.host[operation]).mockImplementationOnce(async () => {
    bindings.set(computerId, { ...original, connectionId: 'offline:1' })
    await pairing.assertCurrent(original)
    throw new Error('A stale connection must never complete an operation')
  })
  const job = (await admitBrowserProfileSync(f.service, f.owner, {})).value
  const coordinator = new BrowserProfileSyncCoordinator(f.service)
  const waiting = await coordinator.reconcile(job.id)
  expect(waiting.state).toBe('running')
  expect(waiting.profiles.every(value => value.state !== 'failed')).toBe(true)
  expect(waiting.targets.every(value => value.state !== 'failed')).toBe(true)
  bindings.set(computerId, { ...original, connectionId: 'reconnected' })
  expect((await coordinator.reconcile(job.id)).state).toBe('completed')
  const calls = vi.mocked(f.host[operation]).mock.calls
  expect(calls).toHaveLength(2)
  expect(calls[1]).toEqual(calls[0])
})

it('keeps replacement installations terminal while a new connection for the same installation is retryable', async () => {
  const { pairing, bindings } = pairingFixture(), original = await pairing.current('worker')
  bindings.set('worker', { ...original, connectionId: 'reconnected' })
  await expect(pairing.assertCurrent(original)).rejects.toMatchObject({ status: 503 })
  bindings.set('worker', { ...original, installationId: 'replacement' })
  await expect(pairing.assertCurrent(original)).rejects.toMatchObject({ code: 'BROWSER_PAIRING_CHANGED', status: 409 })
})

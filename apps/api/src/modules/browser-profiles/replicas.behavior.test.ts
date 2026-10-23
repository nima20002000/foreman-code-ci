import { expect, it } from 'vitest'
import { profileWorkFixture } from './work.test-support.js'

it('never stores a remove intent without an installation when a replica is added while remove is being admitted', async () => {
  const f = profileWorkFixture()
  const profile = (await f.service.create(f.owner, { name: 'Profile', computerId: 'source' })).value
  const installation = f.host.installation
  let injected = false
  f.host.installation = async computerId => {
    const value = await installation(computerId)
    if (!injected) { injected = true; await f.service.addExisting(f.owner, { profileId: profile.id, computerId: 'worker' }) }
    return value
  }
  const outcome = await f.service.remove(f.owner, { profileId: profile.id }).then(receipt => receipt.value, (error: unknown) => error)
  const stored = (await f.service.get(f.owner, profile.id).catch(() => ({ operations: [] }))).operations
  for (const intent of [...(Array.isArray(outcome) ? outcome : []), ...stored]) expect(intent.installationId).toEqual(expect.any(String))
  expect(Array.isArray(outcome) ? outcome.map(value => value.computerId).sort() : outcome).toEqual(['source', 'worker'])
})

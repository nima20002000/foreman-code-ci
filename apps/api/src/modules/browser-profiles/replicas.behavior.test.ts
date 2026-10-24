import { expect, it } from 'vitest'
import { profileWorkFixture } from './work.test-support.js'

async function profileWithWorkerReplica() {
  const f = profileWorkFixture()
  const profile = (await f.service.create(f.owner, { name: 'Profile', computerId: 'source' })).value
  await f.service.addExisting(f.owner, { profileId: profile.id, computerId: 'worker' })
  return { f, profile }
}

it('reads and updates a profile whose stale replica sits on an unpaired computer', async () => {
  const { f, profile } = await profileWithWorkerReplica()
  f.unpaired.add('worker')
  expect((await f.service.get(f.owner, profile.id)).replicas.map(value => value.computerId).sort()).toEqual(['source', 'worker'])
  const updated = await f.service.update(f.owner, { profileId: profile.id, patch: { name: 'Renamed' } })
  expect(updated.value.name).toBe('Renamed')
})

it('removes a profile everywhere while a stale replica sits on an unpaired computer', async () => {
  const { f, profile } = await profileWithWorkerReplica()
  f.unpaired.add('worker')
  const removed = await f.service.remove(f.owner, { profileId: profile.id })
  expect(removed.value.map(value => value.computerId)).toEqual(['source'])
})

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

it('adds an unpublished shared profile as an empty local copy without contacting its source', async () => {
  const f = profileWorkFixture()
  const profile = (await f.service.create(f.owner, { name: 'Demo profile', computerId: 'source' })).value
  f.unpaired.add('source')
  const receipt = await f.service.addExisting(f.owner, { profileId: profile.id, computerId: 'worker' })
  expect(receipt.value).toMatchObject({ state: 'queued', replica: { desiredSnapshot: null } })
  const worker = (await f.service.get(f.owner, profile.id)).operations.find(value => value.computerId === 'worker')
  expect(worker).toMatchObject({ operation: 'create', state: 'queued' })
  expect(f.host.export).not.toHaveBeenCalled()
})

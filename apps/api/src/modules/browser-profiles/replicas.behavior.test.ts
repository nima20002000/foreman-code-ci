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

import { afterEach, expect, it, vi } from 'vitest'
import { profileWorkFixture } from './work.test-support.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

it('reports a native create failure, keeps the operation queued with its reason, and completes it on a later pass', async () => {
  const f = profileWorkFixture(), failure = new Error('native create exploded')
  vi.mocked(f.host.create).mockRejectedValueOnce(failure)
  const profile = (await f.service.create(f.owner, { name: 'Profile', computerId: 'source' })).value
  const dispatcher = f.dispatcher(); cleanup.push(() => dispatcher.stop()); dispatcher.start()
  await vi.waitFor(() => expect(f.failures).toHaveBeenCalledWith(failure, expect.objectContaining({ kind: 'intent' })))
  const [operation] = (await f.service.get(f.owner, profile.id)).operations
  expect(operation).toMatchObject({ state: 'queued' })
  expect(operation!.reason).toEqual(expect.any(String))
  dispatcher.wake()
  await vi.waitFor(async () => expect((await f.service.catalog(f.owner)).presentReplicas).toEqual([{ profileId: profile.id, computerId: 'source' }]))
  expect(f.host.create).toHaveBeenCalledTimes(2)
})

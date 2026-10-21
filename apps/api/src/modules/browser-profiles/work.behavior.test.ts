import { afterEach, expect, it, vi } from 'vitest'
import { BrowserProfileSyncCoordinator, admitBrowserProfileSync, readBrowserProfileSync } from './sync.js'
import { reconcileBrowserProfileIntent } from './reconcile.js'
import { profileWorkFixture } from './work.test-support.js'
import { held } from '../browser-runtime/recovery.test-support.js'

const cleanup: Array<() => Promise<void>> = []
afterEach(async () => { for (const dispose of cleanup.splice(0).reverse()) await dispose() })

it('starts from retained pending creates, waits for in-flight work on stop, and recovers removal with a replacement dispatcher', async () => {
  const f = profileWorkFixture(), entered = held<void>(), finish = held<void>()
  const profile = (await f.service.create(f.owner, { name: 'Profile', computerId: 'source', commandId: 'create' })).value
  vi.mocked(f.host.create).mockImplementationOnce(async () => { entered.resolve(); await finish.promise })
  expect(f.host.create).not.toHaveBeenCalled()
  const first = f.dispatcher(); cleanup.push(() => first.stop()); first.start()
  await entered.promise
  let stopped = false
  const stopping = first.stop().then(() => { stopped = true })
  await Promise.resolve(); expect(stopped).toBe(false)
  finish.resolve(); await stopping
  expect((await f.service.catalog(f.owner)).presentReplicas).toEqual([{ profileId: profile.id, computerId: 'source' }])
  await f.service.remove(f.owner, { profileId: profile.id, computerId: 'source', commandId: 'remove' })
  first.wake()
  expect(f.host.remove).not.toHaveBeenCalled()
  const recovered = f.dispatcher(); cleanup.push(() => recovered.stop()); recovered.start()
  await vi.waitFor(async () => expect((await f.service.catalog(f.owner)).pendingReplicas).toEqual([]))
  expect((await f.service.catalog(f.owner)).presentReplicas).toEqual([])
  expect(f.host.create).toHaveBeenCalledTimes(1)
  expect(f.host.remove).toHaveBeenCalledTimes(1)
  expect(f.failures).not.toHaveBeenCalled()
})

it('advances a retained immutable sync after a wake/restart while repeated offline and busy passes preserve visible revisions', async () => {
  const f = profileWorkFixture(), profile = (await f.service.create(f.owner, { name: 'Profile', computerId: 'source', commandId: 'create' })).value
  const create = (await f.service.get(f.owner, profile.id)).operations[0]!
  await reconcileBrowserProfileIntent(f.service, create.id)
  f.statuses.set('worker', 'offline')
  const jobId = (await admitBrowserProfileSync(f.service, f.owner, { profileIds: [profile.id], commandId: 'sync' })).value.id
  const coordinator = new BrowserProfileSyncCoordinator(f.service)
  const readJob = async () => (await readBrowserProfileSync(f.service, f.owner, { jobId })).job
  await coordinator.reconcile(jobId)
  const offline = await readJob(), offlineRevision = (await f.service.catalog(f.owner)).revision
  await coordinator.reconcile(jobId); await coordinator.reconcile(jobId)
  expect(await readJob()).toEqual(offline)
  expect((await f.service.catalog(f.owner)).revision).toBe(offlineRevision)
  f.statuses.set('worker', 'busy')
  await coordinator.reconcile(jobId)
  const busy = await readJob(), busyRevision = (await f.service.catalog(f.owner)).revision
  await coordinator.reconcile(jobId); await coordinator.reconcile(jobId)
  expect(await readJob()).toEqual(busy)
  expect((await f.service.catalog(f.owner)).revision).toBe(busyRevision)
  expect(f.host.receive).not.toHaveBeenCalled(); expect(f.host.apply).not.toHaveBeenCalled()
  const dispatcher = f.dispatcher(); cleanup.push(() => dispatcher.stop()); dispatcher.start()
  await vi.waitFor(() => expect(f.host.status).toHaveBeenCalled())
  f.statuses.set('worker', 'ready'); dispatcher.wake()
  await vi.waitFor(async () => expect((await readJob()).state).toBe('completed'))
  await dispatcher.stop()
  const completed = await readJob()
  expect(completed.targets.find(value => value.computerId === 'worker')?.snapshot).toEqual(offline.targets.find(value => value.computerId === 'worker')?.snapshot)
  expect(f.host.export).toHaveBeenCalledTimes(1)
  expect(f.host.receive).toHaveBeenCalledTimes(1); expect(f.host.apply).toHaveBeenCalledTimes(1)
  await new BrowserProfileSyncCoordinator(f.service).reconcile(jobId)
  expect(await readJob()).toEqual(completed)
  expect(f.host.apply).toHaveBeenCalledTimes(1)
  expect(f.failures).not.toHaveBeenCalled()
})

it('leaves an offline create pending without catalog revision churn and processes it after explicit readiness wake', async () => {
  const f = profileWorkFixture(); f.statuses.set('source', 'offline')
  const profile = (await f.service.create(f.owner, { name: 'Offline profile', computerId: 'source', commandId: 'create-offline' })).value
  const intent = (await f.service.get(f.owner, profile.id)).operations[0]!
  await reconcileBrowserProfileIntent(f.service, intent.id)
  const before = await f.service.catalog(f.owner)
  await reconcileBrowserProfileIntent(f.service, intent.id); await reconcileBrowserProfileIntent(f.service, intent.id)
  expect(await f.service.catalog(f.owner)).toEqual(before)
  const dispatcher = f.dispatcher(); cleanup.push(() => dispatcher.stop()); dispatcher.start()
  f.statuses.set('source', 'ready'); dispatcher.wake()
  await vi.waitFor(async () => expect((await f.service.catalog(f.owner)).presentReplicas).toEqual([{ profileId: profile.id, computerId: 'source' }]))
  expect(f.host.create).toHaveBeenCalledTimes(1)
  expect(f.failures).not.toHaveBeenCalled()
})

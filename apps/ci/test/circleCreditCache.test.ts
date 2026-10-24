import { mkdir, mkdtemp, rm } from 'node:fs/promises'
import { homedir } from 'node:os'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { deferred } from './helpers/deferred.js'
import { CircleCreditCache, circleCreditKey } from '../src/circleCreditCache.js'
import { withHostCiRunLock } from '../src/runnerLock.js'
import { testCiContext } from './helpers/ciContext.js'

const pending = Symbol('pending')
const within = <T>(promise: Promise<T>, ms: number) =>
  Promise.race([promise, new Promise<typeof pending>(resolve => setTimeout(() => resolve(pending), ms))])

it('reads credit state while another process holds the CI lock, and waits for it only to write', async () => {
  const parent = process.env.FOREMAN_CODE_TEST_ROOT ?? join(homedir(), '.cache', 'foreman-tmp')
  await mkdir(parent, { recursive: true })
  const directory = await mkdtemp(join(parent, 'circle-cache-'))
  const path = join(directory, 'usage.json')
  const key = circleCreditKey('acme')
  try {
    await new CircleCreditCache(testCiContext, path).transaction(states => { states[key] = { attempts: [1] } })
    const entered = deferred(), release = deferred()
    const holder = withHostCiRunLock(testCiContext, directory, async () => { entered.resolve(); await release.promise })
    await entered.promise

    const reader = new CircleCreditCache(testCiContext, path)
    expect(await within(reader.transaction(states => structuredClone(states[key])), 1000)).toEqual({ attempts: [1] })

    const write = reader.transaction(states => { states[key]!.attempts.push(2) })
    expect(await within(write, 300)).toBe(pending)
    release.resolve()
    await holder
    await write
    expect(await new CircleCreditCache(testCiContext, path).transaction(states => states[key])).toEqual({ attempts: [1, 2] })
  } finally {
    await rm(directory, { recursive: true, force: true })
  }
})

import { expect, it } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { DomainError } from '../errors.js'
import { createAdmittedNativeManager } from './admittedManager.js'
import type { NativeHarnessSessionManager } from './port.js'

it('cancels an admission that has not produced an allocation when disposal starts', async () => {
  const entered = deferred()
  let attempts = 0
  const admitted = createAdmittedNativeManager('codex', signal => {
    attempts++
    entered.resolve()
    return new Promise<never>((_resolve, reject) => {
      const abort = () => reject(signal.reason)
      signal.addEventListener('abort', abort, { once: true })
      if (signal.aborted) abort()
    })
  })
  const opening = admitted.manager.capabilities().then(value => value, error => error)
  await entered.promise
  await admitted.manager.dispose!()
  expect(await opening).toMatchObject({ code: 'NATIVE_MANAGER_DISPOSED' })
  await expect(admitted.manager.capabilities()).rejects.toMatchObject({ code: 'NATIVE_MANAGER_DISPOSED' })
  expect(attempts).toBe(1)
})

it('admits again after an admission failed while the profile check was still running', async () => {
  const capabilities = { models: [] }
  let attempts = 0
  const admitted = createAdmittedNativeManager('codex', async () => {
    attempts++
    if (attempts === 1) throw new DomainError('HARNESS_PROFILE_CHECK_PENDING', 'The selected harness profile is being checked.', 503)
    return { manager: { harness: 'codex', capabilities: async () => capabilities } as unknown as NativeHarnessSessionManager }
  })
  await expect(admitted.manager.capabilities()).rejects.toMatchObject({ code: 'HARNESS_PROFILE_CHECK_PENDING' })
  expect(await admitted.manager.capabilities()).toBe(capabilities)
  expect(attempts).toBe(2)
})

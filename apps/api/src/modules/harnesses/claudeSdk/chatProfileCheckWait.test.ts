import { expect, it } from 'vitest'
import { DomainError } from '../../errors.js'
import { admitWhenChecked } from '../instanceSettings/profileCheckWait.js'

const pending = () => new DomainError('HARNESS_PROFILE_CHECK_PENDING', 'The selected harness profile is being checked.', 503)

it('lets a chat message or Run start wait for the in-flight profile check instead of failing', async () => {
  let attempts = 0
  const admitted = await admitWhenChecked(async () => {
    attempts++
    if (attempts < 3) throw pending()
    return 'accepted'
  }, new AbortController().signal)
  expect(admitted).toBe('accepted')
  expect(attempts).toBe(3)
})

it('stops waiting at its deadline and keeps other failures', async () => {
  await expect(admitWhenChecked(async () => { throw pending() }, new AbortController().signal, 0))
    .rejects.toMatchObject({ code: 'HARNESS_PROFILE_CHECK_PENDING' })
  await expect(admitWhenChecked(async () => { throw new DomainError('HARNESS_PROFILE_UNAVAILABLE', 'gone', 409) },
    new AbortController().signal)).rejects.toMatchObject({ code: 'HARNESS_PROFILE_UNAVAILABLE' })
})

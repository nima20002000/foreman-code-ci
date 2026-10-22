import { expect, it } from 'vitest'
import { DomainError } from '../../errors.js'
import { admitChatWhenChecked } from './production.js'

const pending = () => new DomainError('HARNESS_PROFILE_CHECK_PENDING', 'The selected harness profile is being checked.', 503)

it('lets a chat message wait for the in-flight profile check instead of failing', async () => {
  let attempts = 0
  const admitted = await admitChatWhenChecked(false, async () => {
    attempts++
    if (attempts < 3) throw pending()
    return 'accepted'
  }, new AbortController().signal)
  expect(admitted).toBe('accepted')
  expect(attempts).toBe(3)
})

it('keeps the retryable pending result for Run launches and stops waiting at its deadline', async () => {
  await expect(admitChatWhenChecked(true, async () => { throw pending() }, new AbortController().signal))
    .rejects.toMatchObject({ code: 'HARNESS_PROFILE_CHECK_PENDING' })
  await expect(admitChatWhenChecked(false, async () => { throw pending() }, new AbortController().signal, 0))
    .rejects.toMatchObject({ code: 'HARNESS_PROFILE_CHECK_PENDING' })
})

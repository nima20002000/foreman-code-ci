import { randomUUID } from 'node:crypto'
import { expect, it } from 'vitest'
import { fixture } from './cloud.testSupport.js'

const suspended = 'error: API returned 403: {"message":"Your account has been suspended. Please contact support for more information."}'

it('ends a CircleCI cancellation the account refuses instead of asking again on every read', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId, repository: 'octo/site',
    commit: f.commit, suite: 'lint', scope: 'full' })
  await f.cloud.handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 })
  expect(f.circle.triggered).toHaveLength(1)
  f.circle.lookupError = suspended
  f.circle.cancelError = suspended
  await f.cloud.handle({ operation: 'cancel', runId })
  f.advance(75_001)
  for (let poll = 0; poll < 3; poll++) {
    f.advance(4_000)
    await expect(f.reopen().handle({ operation: 'read', runId, afterOffset: 0, maxBytes: 1 }))
      .resolves.toMatchObject({ run: { state: 'canceled' } })
  }
  expect(f.circle.canceled).toEqual(['run-1'])
})

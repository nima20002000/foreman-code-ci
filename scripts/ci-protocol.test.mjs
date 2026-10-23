import assert from 'node:assert/strict'
import { test } from 'node:test'
import { CI_TEST_RESULT_LIMITS, ciTestResults } from '../packages/ci-protocol/src/testResults.mjs'

test('the CI scripts and Main agree on the bounds of a ticket’s test results', async () => {
  const contracts = await import('../packages/contracts/dist/ciHost.js')
  assert.deepEqual(CI_TEST_RESULT_LIMITS, contracts.CI_TEST_RESULT_LIMITS)
})

test('a merged report is a message Main accepts', async () => {
  const { CiTestResultsSchema } = await import('../packages/contracts/dist/ciHost.js')
  const results = ciTestResults([{ testResults: [{ name: '/repo/apps/api/test/a.test.ts', status: 'failed',
    startTime: 0, endTime: 40, assertionResults: [
      { fullName: 'a passes', status: 'passed', duration: 3 },
      { fullName: 'a fails', status: 'failed', duration: 9, failureMessages: ['AssertionError: expected 1 to be 2'] },
    ] }] }], '/repo')
  assert.equal(CiTestResultsSchema.safeParse(results).success, true)
  assert.deepEqual(results.summary, { passed: 1, failed: 1, skipped: 0 })
})

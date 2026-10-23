import { randomUUID } from 'node:crypto'
import { join } from 'node:path'
import { afterEach, expect, it, vi } from 'vitest'
import { deferred } from '../../../test/helpers/deferred.js'
import { fixture } from './cloud.testSupport.js'
import { CircleCiProvider, type CloudRun } from './cloudProviders.js'

afterEach(() => vi.restoreAllMocks())

const results = { summary: { passed: 1, failed: 0, skipped: 0 }, files: [], truncated: false }

it('downloads CircleCI result files four at a time and waits for every file', async () => {
  const f = await fixture({}, { provider: 'circleci' })
  f.circle.artifacts = { 'durations/durations.json': { 'test.ts': 12 }, 'durations/test-results.json': results,
    'durations/integration-coverage.json': {}, 'durations/selection.json': {},
    'durations/watchdog-message.json': {}, 'durations/suite.log': 'Suite output\n' }
  const gate = deferred()
  f.circle.downloadGate = gate.promise
  const provider = new CircleCiProvider(f.ports, { circleToken: async () => null })
  const run: CloudRun = { runId: randomUUID(), repository: 'octo/site', mirror: 'octo/site-ci', commit: f.commit,
    suite: 'unit', startedAt: f.ports.now().toISOString(), providerRunId: 'run-1', state: 'passed',
    finishedAt: f.ports.now().toISOString(), exitCode: 0, message: null }
  let settled = false
  const collecting = provider.artifacts(run, join(f.root, 'results')).finally(() => { settled = true })
  try {
    await expect.poll(() => f.circle.downloaded.length).toBe(4)
    expect(settled).toBe(false)
  } finally {
    gate.resolve()
    await collecting
  }
  expect(f.circle.downloaded).toHaveLength(6)
  expect(await collecting).toMatchObject({ durations: { 'test.ts': 12 }, testResults: results, suiteLog: 'Suite output\n' })
})

it.each(['github', 'circleci'] as const)('collects uploaded %s results before cache saves finish and retains the running job', async provider => {
  const f = await fixture({}, { provider })
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'unit', scope: 'full' })
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  f.github.steps = [
    { number: 1, name: 'Suite', status: 'completed', conclusion: 'success' },
    { number: 2, name: 'Run actions/upload-artifact@v4', status: 'completed', conclusion: 'success' },
    { number: 3, name: 'Post cache', status: 'in_progress', conclusion: null },
  ]
  Object.assign(f.github, { durations: {}, testResults: results, suiteLog: 'Suite output\n' })
  f.circle.steps = [
    { num: 1, name: 'Suite', phase: 'ended', outcome: 'succeeded' },
    { num: 2, name: 'Uploading artifacts', phase: 'ended', outcome: 'succeeded' },
    { num: 3, name: 'Saving cache', phase: 'started' },
  ]
  f.circle.artifacts = { 'durations/suite.log': 'Suite output\n', 'durations/test-results.json': results }
  const artifacts = vi.spyOn(f.cloud.provider, 'artifacts')
  const logs = vi.spyOn(f.cloud.provider, 'log')
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024, testResults: true }
  expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'running', finishedAt: null, collection: 'complete' },
    testResults: results, text: 'Suite output\n' })
  expect(logs).not.toHaveBeenCalled()
  expect(artifacts).toHaveBeenCalledTimes(1)
  Object.assign(f.github, { status: 'completed', conclusion: 'success' })
  f.circle.outcome = 'succeeded'
  f.advance(4_001)
  expect(await f.reopen().handle(read)).toMatchObject({ run: { state: 'passed', collection: 'complete' },
    testResults: results, text: 'Suite output\n' })
  expect(artifacts).toHaveBeenCalledTimes(1)
})

it('answers a terminal observation before starting result collection', async () => {
  const f = await fixture()
  const runId = randomUUID()
  await f.cloud.handle({ operation: 'start', workspaceId: 'ci-workspace', runId,
    repository: 'octo/site', commit: f.commit, suite: 'lint', scope: 'full' })
  f.github.listed = [{ databaseId: 91, displayTitle: `ci ${runId}` }]
  Object.assign(f.github, { status: 'completed', conclusion: 'success' })
  const artifacts = vi.spyOn(f.cloud.provider, 'artifacts').mockResolvedValue({ durations: null,
    testResults: null, suiteLog: 'Suite output\n' })
  const read = { operation: 'read', runId, afterOffset: 0, maxBytes: 1024 }
  expect(await f.cloud.handle({ ...read, observeOnly: true }))
    .toMatchObject({ run: { state: 'passed', collection: 'pending' } })
  expect(artifacts).not.toHaveBeenCalled()
  expect(await f.cloud.handle(read)).toMatchObject({ run: { state: 'passed', collection: 'complete' }, text: 'Suite output\n' })
})

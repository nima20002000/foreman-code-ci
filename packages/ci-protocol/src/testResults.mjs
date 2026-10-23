// The test-result message a CI part writes and Main reads (CiTestResultsSchema in @foreman-code/contracts): the limits
// that bound it and the merge of Vitest JSON reports into it. Plain ESM without dependencies, so the repository's CI
// scripts import it by relative path from the repository under test, as they do the contracts' .mjs files.
import { isAbsolute, relative } from 'node:path'

export const CI_TEST_RESULT_LIMITS = { tests: 600, files: 300, name: 200, file: 200, message: 240, location: 240 }
const rank = { failed: 0, skipped: 1, passed: 2 }
const DAY_MS = 24 * 3_600_000

const clip = (value, max) => value.length > max ? `${value.slice(0, max - 1)}…` : value
const testStatus = value => value === 'passed' || value === 'failed' ? value : 'skipped'
const duration = value => typeof value === 'number' && Number.isFinite(value) && value >= 0 ? Math.min(value, DAY_MS) : null
// Terminal colors and control characters say nothing in a table.
const plain = value => String(value ?? '').replace(/\u001b\[[0-9;]*[A-Za-z]/g, '').replace(/[\u0000-\u0008\u000b-\u001f\u007f]/g, '')
const stackFrame = /(?:file:\/\/)?(\/[^\s()'"]+):(\d+):(\d+)/g

/** Where a failure happened: the stack frame in the test's own file, else the first repository frame outside
 * node_modules, as `path:line:column` relative to the repository. The message is clipped, so the stack is read here. */
function failureLocation(failure, file, repository) {
  let fallback
  for (const [, path, line, column] of failure.matchAll(stackFrame)) {
    const local = relative(repository, path).replaceAll('\\', '/')
    if (!local || local.startsWith('../') || isAbsolute(local) || local.split('/').includes('node_modules')) continue
    const location = `${local}:${line}:${column}`
    if (local === file) return location
    fallback ??= location
  }
  return fallback
}

/** Merges Vitest JSON reports. Failed tests are kept first, then skipped, then passed; summary counts every test. */
export function ciTestResults(reports, repository) {
  const summary = { passed: 0, failed: 0, skipped: 0 }
  const byFile = new Map()
  for (const report of reports) {
    for (const result of Array.isArray(report?.testResults) ? report.testResults : []) {
      if (typeof result?.name !== 'string' || !result.name) continue
      const path = (isAbsolute(result.name) ? relative(repository, result.name) : result.name).replaceAll('\\', '/')
      const tests = (Array.isArray(result.assertionResults) ? result.assertionResults : []).map(test => {
        const status = testStatus(test?.status)
        summary[status]++
        const name = clip(plain(test?.fullName || test?.title).trim() || 'Unnamed test', CI_TEST_RESULT_LIMITS.name)
        const failure = status === 'failed' && Array.isArray(test?.failureMessages) ? plain(test.failureMessages[0]).trim() : ''
        const message = clip(failure, CI_TEST_RESULT_LIMITS.message)
        const location = failure && failureLocation(failure, path, repository)
        return { name, status, durationMs: duration(test?.duration), ...(message ? { message } : {}),
          ...(location ? { location: clip(location, CI_TEST_RESULT_LIMITS.location) } : {}) }
      })
      let status = 'passed'
      if (result.status === 'failed' || tests.some(test => test.status === 'failed')) status = 'failed'
      else if (tests.length && tests.every(test => test.status === 'skipped')) status = 'skipped'
      const file = clip(path || 'unknown file', CI_TEST_RESULT_LIMITS.file)
      byFile.set(file, { file, status, durationMs: duration(result.endTime - result.startTime), tests })
    }
  }
  const files = [...byFile.values()].sort((left, right) => rank[left.status] - rank[right.status]
    || (left.file < right.file ? -1 : left.file > right.file ? 1 : 0))
  const kept = files.slice(0, CI_TEST_RESULT_LIMITS.files)
  const all = kept.flatMap((file, fileIndex) => file.tests.map((test, index) => ({ fileIndex, index, rank: rank[test.status] })))
  const chosen = new Set(all.sort((left, right) => left.rank - right.rank || left.fileIndex - right.fileIndex
    || left.index - right.index).slice(0, CI_TEST_RESULT_LIMITS.tests).map(entry => `${entry.fileIndex}:${entry.index}`))
  const tests = summary.passed + summary.failed + summary.skipped
  return { summary, truncated: kept.length < files.length || chosen.size < tests,
    files: kept.map((file, fileIndex) => ({ ...file, tests: file.tests.filter((_, index) => chosen.has(`${fileIndex}:${index}`)) })) }
}

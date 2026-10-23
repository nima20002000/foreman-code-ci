// Turns Vitest JSON reports into the bounded structured test results a CI ticket keeps (CiTestResultsSchema).
//   node scripts/ci-test-results.mjs <output> <vitest-report.json>...
// Every expected report must be readable and structurally valid before publishing merged results.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { CI_TEST_RESULT_LIMITS, ciTestResults as mergeCiTestResults } from '../packages/ci-protocol/src/testResults.mjs'

const root = fileURLToPath(new URL('..', import.meta.url))
export { CI_TEST_RESULT_LIMITS }

/** Merges Vitest JSON reports; paths are made relative to the repository (default: this checkout). */
export const ciTestResults = (reports, repository = root) => mergeCiTestResults(reports, repository)

function readReport(path) {
  let report
  try {
    report = JSON.parse(readFileSync(path, 'utf8'))
  } catch (error) {
    const reason = error instanceof SyntaxError ? 'invalid JSON' : 'unreadable or missing'
    throw new Error(`Expected test report ${path} is ${reason}.`)
  }
  if (!report || !Array.isArray(report.testResults)
    || report.testResults.some(result => !result || typeof result.name !== 'string'
      || !result.name || !Array.isArray(result.assertionResults))) {
    throw new Error(`Expected test report ${path} has an invalid structure.`)
  }
  return report
}

/** Publishes results only after every expected report has been collected. */
export function writeCiTestResults(output, paths, repository = root) {
  if (!paths.length) throw new Error('Expected at least one test report.')
  const reports = paths.map(readReport)
  mkdirSync(dirname(output), { recursive: true })
  const temporary = `${output}.${process.pid}.tmp`
  writeFileSync(temporary, JSON.stringify(ciTestResults(reports, repository)), { mode: 0o600 })
  renameSync(temporary, output)
  return true
}

if (process.argv[1] && import.meta.url === `file://${resolve(process.argv[1])}`) {
  const [output, ...reports] = process.argv.slice(2)
  if (!output) throw new Error('Usage: ci-test-results.mjs <output> <vitest-report.json>...')
  writeCiTestResults(resolve(output), reports.map(path => resolve(path)))
}

// Live regression check: node scripts/verify-ci-cache-run.mjs <public mirror> <completed snapshot run id>
// Uses provider responses, not workflow source. Run after the main-branch warmer completes.
import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'

const [mirror, runId] = process.argv.slice(2)
assert(mirror && /^\d+$/.test(runId), 'Supply a mirror and completed GitHub Actions run id')
const gh = args => execFileSync('gh', args, { encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 })
const api = path => JSON.parse(gh(['api', `repos/${mirror}/${path}`]))
const run = api(`actions/runs/${runId}`)
assert(run.head_branch.startsWith('ci-snapshot/'), 'The check must retain immutable snapshot provenance')
assert.equal(run.status, 'completed')
const job = api(`actions/runs/${runId}/jobs?per_page=100`).jobs.find(value => value.name === 'ci')
const result = api(`actions/runs/${runId}/artifacts`).artifacts.find(value => value.name === 'durations')
assert(job && result, 'The suite job and published result artifact must exist')
const saves = job.steps.filter(step => /Save .*cache|Post Run actions\/cache@/.test(step.name)
  && step.status === 'completed' && step.conclusion !== 'skipped')
assert(saves.every(step => Date.parse(step.started_at) >= Date.parse(result.created_at)),
  'Result artifacts must be published before any cache save starts')
assert(!saves.some(step => step.name.startsWith('Post Run actions/cache@')),
  'Snapshot checks must not upload dependency caches in post-job steps')
const log = gh(['run', 'view', runId, '-R', mirror, '--log'])
const keys = [...log.matchAll(/Cache restored from key: (\S+)/g)].map(match => match[1])
const { default_branch: defaultBranch } = JSON.parse(gh(['api', `repos/${mirror}`]))
const caches = api(`actions/caches?ref=${encodeURIComponent(`refs/heads/${defaultBranch}`)}&per_page=100`).actions_caches
for (const prefix of ['clis-v1-', 'packages-v2-', 'pnpm-metadata-v2-', 'pnpm-store-v2-', 'contracts-build-']) {
  assert(keys.some(key => key.startsWith(prefix) && caches.some(cache => cache.key === key)),
    `Snapshot must restore a default-branch cache for ${prefix}`)
}
const suite = job.steps.find(step => step.name === 'Suite')
assert(suite && suite.conclusion !== 'skipped', 'The suite must execute')
const seconds = (start, end) => (Date.parse(end) - Date.parse(start)) / 1000
console.log(JSON.stringify({ runId, conclusion: job.conclusion, dependencyHits: 5,
  jobSeconds: seconds(job.started_at, job.completed_at),
  suiteSeconds: seconds(suite.started_at, suite.completed_at),
  suiteToJobEndSeconds: seconds(suite.completed_at, job.completed_at),
  resultToJobEndSeconds: seconds(result.created_at, job.completed_at) }))

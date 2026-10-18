import assert from 'node:assert/strict'
import { execFileSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { affectedSnapshot, selectAffectedFiles } from './ci-affected.mjs'

const source = 'apps/api/src/feature.ts'
const other = 'apps/api/src/other.ts'
const first = 'apps/api/test/feature.integration.test.ts'
const second = 'apps/api/test/other.integration.test.ts'
const bootstrap = 'apps/api/src/app.ts'
const sources = new Map([
  [source, 'export const feature = () => 1'],
  [other, 'export const other = () => 2'],
  [bootstrap, "import './feature.js'; import './other.js'"],
  [first, "import '../src/app.js'"],
  [second, "import '../src/app.js'"],
])
const coverageMap = { version: 1, commit: 'a'.repeat(40), testFiles: [first, second],
  coverage: { [first]: [source, bootstrap], [second]: [other, bootstrap] } }
const select = (changedFiles, extra = {}) => selectAffectedFiles({
  suite: 'integration', changedFiles, sources, coverageMap, ...extra,
})

test('coverage avoids bootstrap import fan-out and explains its selection', () => {
  const result = select([source])
  assert.equal(result.scope, 'affected')
  assert.deepEqual(result.files, [first])
  assert.match(result.reason, /coverage/i)
  assert.ok(result.reason.includes(coverageMap.commit))
})

test('coverage always includes changed tests and tests absent from the map', () => {
  const added = 'apps/api/test/added.integration.test.ts'
  assert.deepEqual(select([source, second, added], {
    sources: new Map([...sources, [added, 'export {}']]),
  }).files, [added, first, second].sort())
  assert.deepEqual(select([], { sources: new Map([...sources, [added, 'export {}']]) }).files, [added])
})

test('unrecorded changed sources use static reachability alongside coverage matches', () => {
  const added = 'apps/api/src/added.ts'
  const graph = new Map([...sources, [added, 'export const value = 3'],
    [bootstrap, "import './added.js'; import './feature.js'; import './other.js'"]])
  assert.deepEqual(select([added], { sources: graph }).files, [first, second])
  assert.match(select([added], { sources: graph }).reason, /static/i)
})

test('tests that execute child processes retain static reachability', () => {
  assert.deepEqual(select([source], { coverageMap: { ...coverageMap, staticTests: [second] } }).files,
    [first, second])
})

test('missing, malformed and incomplete maps retain static selection with a reason', () => {
  for (const map of [undefined, {}, { ...coverageMap, coverage: { [first]: [source] } },
    { ...coverageMap, coverage: { [first]: ['/private/source.ts'], [second]: [other] } }]) {
    const result = select([source], { coverageMap: map })
    assert.deepEqual(result.files, [first, second])
    assert.match(result.reason, /static/i)
  }
})

test('coverage cannot narrow shared infrastructure changes or change other suites', () => {
  for (const file of ['pnpm-lock.yaml', 'scripts/ci-suite.sh', 'apps/api/test/helpers/shared.ts']) {
    assert.equal(select([file]).scope, 'full')
  }
  const unit = 'apps/api/src/feature.test.ts'
  assert.deepEqual(select([source], { suite: 'unit',
    sources: new Map([...sources, [unit, "import './app.js'"]]) }).files, [unit])
})

function repository(t) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(cache, { recursive: true })
  const root = mkdtempSync(join(cache, 'coverage-selection-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8',
    env: { ...process.env, GIT_AUTHOR_NAME: 'Fixture', GIT_AUTHOR_EMAIL: 'fixture@example.invalid',
      GIT_COMMITTER_NAME: 'Fixture', GIT_COMMITTER_EMAIL: 'fixture@example.invalid' } }).trim()
  git('init', '-q', '-b', 'main')
  const put = (file, text) => {
    mkdirSync(dirname(join(root, file)), { recursive: true })
    writeFileSync(join(root, file), text)
  }
  for (const [file, text] of sources) put(file, text)
  const commit = message => { git('add', '.'); git('commit', '-qm', message); return git('rev-parse', 'HEAD') }
  const base = commit('initial')
  return { root, git, put, commit, base }
}

test('snapshot uses the newest ancestor map and includes intervening changes', t => {
  const f = repository(t)
  const oldMap = { ...coverageMap, commit: f.base }
  f.put(source, 'export const feature = () => 3')
  const middle = f.commit('feature change')
  const recent = { ...coverageMap, commit: middle }
  f.put(other, 'export const other = () => 4')
  const head = f.commit('other change')
  const result = affectedSnapshot(head, 'integration', f.root, 'main', middle, [oldMap, recent])
  assert.deepEqual(result.files, [second])
  assert.ok(result.reason.includes(middle))
  const drift = affectedSnapshot(head, 'integration', f.root, 'main', middle, [oldMap])
  assert.deepEqual(drift.files, [first, second])
})

test('snapshot rejects non-ancestors and maps predating lockfile or CI infrastructure changes', t => {
  const f = repository(t)
  const map = { ...coverageMap, commit: f.base }
  f.git('checkout', '-qb', 'side')
  f.put('README.md', 'side')
  const side = f.commit('side')
  f.git('checkout', '-q', 'main')
  f.put('pnpm-lock.yaml', 'changed')
  const middle = f.commit('dependencies')
  f.put(source, 'export const feature = () => 4')
  const head = f.commit('feature')
  for (const candidate of [map, { ...map, commit: side }]) {
    const result = affectedSnapshot(head, 'integration', f.root, 'main', middle, [candidate])
    assert.equal(result.scope, 'affected')
    assert.deepEqual(result.files, [first, second])
    assert.match(result.reason, /static/i)
  }
})

test('cheap V8 collection records executed repository files with portable paths', async t => {
  const { startFileCoverage } = await import('./integration-coverage.mjs')
  const f = repository(t)
  const file = join(f.root, 'executed.mjs')
  writeFileSync(file, 'export function value() { return 42 }')
  const stop = await startFileCoverage()
  const loaded = await import(file)
  assert.equal(loaded.value(), 42)
  const files = await stop(f.root, new Set(['executed.mjs']))
  assert.deepEqual(files, ['executed.mjs'])
})

test('V8 collection identifies child process work that needs static selection', async () => {
  const { startFileCoverage } = await import('./integration-coverage.mjs')
  const stop = await startFileCoverage()
  execFileSync(process.execPath, ['-e', 'process.exit(0)'])
  await stop(process.cwd(), new Set())
  assert.equal(stop.requiresStatic, true)
})

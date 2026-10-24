import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./check-worker-imports.mjs', import.meta.url))
const entries = [
  'apps/worker/src/cli.mjs',
  'apps/worker/src/workerFactory.mjs',
  'apps/api/src/modules/byte-transfer/rsyncWriterCli.ts',
  'apps/api/src/modules/harnesses/compatibility/schemaWorker.ts',
]

function fixture(t) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(cache, { recursive: true })
  const root = mkdtempSync(join(cache, 'worker-imports-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  for (const entry of entries) write(entry, 'export {}')
  write('packages/contracts/package.json', JSON.stringify({ exports: {
    './fixture': { import: './dist/fixture.js' },
  } }))
  return { write, run: () => spawnSync(process.execPath, [script, root], { encoding: 'utf8' }) }
}

for (const entry of entries) {
  test(`rejects a transitive database import from ${entry}`, t => {
    const f = fixture(t)
    f.write(entry, "import '@foreman-code/contracts/fixture'")
    f.write('packages/contracts/src/fixture.ts',
      "export * from '../../../apps/api/src/modules/runs/ownerLeases.js'")
    f.write('apps/api/src/modules/runs/ownerLeases.ts',
      "import '../../infrastructure/database.js'")
    f.write('apps/api/src/infrastructure/database.ts', 'export const timeout = 1')
    const result = f.run()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /Forbidden snapshot source: apps\/api\/src\/infrastructure\/database\.ts/)
    assert.match(result.stderr, /ownerLeases\.ts/)
  })
}

test('accepts runtime cycles and ignores unreachable modules, type imports, comments and strings', t => {
  const f = fixture(t)
  f.write(entries[0], [
    "import './safe.mjs'",
    "// import '../../../apps/api/src/server.ts'",
    'const text = "import \'../../../apps/api/src/server.ts\'"',
  ].join('\n'))
  f.write('apps/worker/src/safe.mjs', "export * from './cli.mjs'")
  f.write(entries[2], [
    "import type { Database } from '../../infrastructure/db.js'",
    "import { type Database } from '../../infrastructure/db.js'",
    "export type { Database } from '../../infrastructure/db.js'",
    "export { type Database } from '../../infrastructure/db.js'",
  ].join('\n'))
  f.write('apps/api/src/infrastructure/db.ts', 'export type Database = unknown')
  f.write('apps/api/src/server.ts', "throw new Error('must not execute imported code')")
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
})

test('checks literal dynamic imports bundled into the Worker', t => {
  const f = fixture(t)
  f.write(entries[0], "await import('../../../apps/api/src/production.js')")
  f.write('apps/api/src/production.ts', 'export {}')
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Forbidden snapshot source: apps\/api\/src\/production\.ts/)
})

test('applies the snapshot allowlist to imports outside Worker source directories', t => {
  const f = fixture(t)
  f.write(entries[0], "import '../../../scripts/unlisted.mjs'")
  f.write('scripts/unlisted.mjs', 'export {}')
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Forbidden snapshot source: scripts\/unlisted\.mjs/)
})

test('follows a JavaScript module with a sibling declaration to the JavaScript the bundler loads', t => {
  const f = fixture(t)
  f.write(entries[2], "import { run } from '../../../../../scripts/verification-runner.mjs'\nrun()")
  f.write('scripts/verification-runner.mjs', 'export function run() {}')
  f.write('scripts/verification-runner.d.mts', 'export declare function run(): void')
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
})

test('follows CI package exports into apps/ci/src and still rejects its database imports', t => {
  const f = fixture(t)
  f.write('apps/ci/package.json', JSON.stringify({ exports: { './runner': { import: './dist/runner.js' } } }))
  f.write(entries[1], "import '../../../apps/api/src/modules/ci/runner.js'")
  f.write('apps/api/src/modules/ci/runner.ts', "export * from '@foreman-code/ci/runner'")
  f.write('apps/ci/src/runner.ts', "import { fixture } from '@foreman-code/contracts/fixture'\nexport { fixture }")
  f.write('packages/contracts/src/fixture.ts', 'export const fixture = 1')
  assert.equal(f.run().status, 0)
  f.write('apps/ci/src/runner.ts', "import '../../api/src/infrastructure/db.js'")
  f.write('apps/api/src/infrastructure/db.ts', 'export const db = 1')
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Forbidden snapshot source: apps\/api\/src\/infrastructure\/db\.ts/)
  assert.match(result.stderr, /apps\/ci\/src\/runner\.ts/)
})


test('bundles Node contracts from source and checks their transitive imports', t => {
  const f = fixture(t)
  f.write('packages/contracts-node/package.json', JSON.stringify({ exports: {
    './server-kit': { import: './dist/serverKit.js' },
  } }))
  f.write(entries[0], "import '@foreman-code/contracts-node/server-kit'")
  f.write('packages/contracts-node/src/serverKit.ts', "import { createHash } from 'node:crypto'; export { createHash }")
  assert.equal(f.run().status, 0)
  f.write('packages/contracts-node/src/serverKit.ts', "import '../../../apps/api/src/infrastructure/db.js'")
  f.write('apps/api/src/infrastructure/db.ts', 'export const db = 1')
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /Forbidden snapshot source: apps\/api\/src\/infrastructure\/db\.ts/)
  assert.match(result.stderr, /packages\/contracts-node\/src\/serverKit\.ts/)
})

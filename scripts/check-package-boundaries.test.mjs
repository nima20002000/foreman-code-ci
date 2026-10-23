import assert from 'node:assert/strict'
import { spawnSync } from 'node:child_process'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

const script = fileURLToPath(new URL('./check-package-boundaries.mjs', import.meta.url))

function fixture(t, { ciDependencies = { '@foreman-code/contracts': 'workspace:*', zod: '4.6.3' },
  apiDependencies = { '@foreman-code/ci': 'workspace:*', '@foreman-code/contracts': 'workspace:*', pg: '8.23.0', zod: '4.6.3' } } = {}) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(cache, { recursive: true })
  const root = mkdtempSync(join(cache, 'package-boundaries-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  const write = (path, text) => {
    mkdirSync(dirname(join(root, path)), { recursive: true })
    writeFileSync(join(root, path), text)
  }
  write('apps/ci/package.json', JSON.stringify({ name: '@foreman-code/ci', dependencies: ciDependencies }))
  write('apps/api/package.json', JSON.stringify({ name: '@foreman-code/api', dependencies: apiDependencies }))
  write('apps/ci/src/runner.ts', [
    "import { readFile } from 'node:fs/promises'",
    "import type { Pool } from 'pg'",
    "import { DomainError } from '@foreman-code/contracts/server-kit'",
    "import { z } from 'zod'",
    "import { status } from './status.js'",
    'export { readFile, DomainError, z, status }',
    'export type Database = Pool',
  ].join('\n'))
  write('apps/ci/src/status.ts', 'export const status = 1')
  write('apps/api/src/modules/ci/runner.ts', "export { HostCiRunner } from '@foreman-code/ci/runner'")
  write('apps/api/src/production.ts', "import { HostCiRunner } from './modules/ci/runner.js'\nexport { HostCiRunner }")
  write('apps/web/src/main.tsx', "import { value } from '@foreman-code/contracts'\nexport { value }")
  write('packages/contracts/src/index.ts', 'export const value = 1')
  return { write, run: () => spawnSync(process.execPath, [script, root], { encoding: 'utf8' }) }
}

test('accepts a CI package that imports only its own modules, builtins, contracts, dependencies and pg types', t => {
  const result = fixture(t).run()
  assert.equal(result.status, 0, result.stderr)
})

for (const [name, text] of [
  ['an API module', "import { pool } from '../../api/src/infrastructure/db.js'"],
  ['an undeclared package', "import fastify from 'fastify'"],
  ['pg at runtime', "import pg from 'pg'"],
  ['its own package by name', "import { status } from '@foreman-code/ci/status'"],
  ['a dynamic undeclared package', "export const load = () => import('fastify')"],
]) {
  test(`rejects a CI package import of ${name}`, t => {
    const f = fixture(t)
    f.write('apps/ci/src/extra.ts', text)
    const result = f.run()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /apps\/ci\/src\/extra\.ts imports/)
  })
}

test('accepts CI tests that import CI files, repository scripts, contracts and CI dev dependencies', t => {
  const f = fixture(t)
  f.write('apps/ci/package.json', JSON.stringify({ name: '@foreman-code/ci',
    dependencies: { '@foreman-code/contracts': 'workspace:*', zod: '4.6.3' }, devDependencies: { vitest: '5.0.5' } }))
  f.write('apps/ci/test/runner.test.ts', [
    "import { expect, it } from 'vitest'",
    "import { join } from 'node:path'",
    "import { DomainError } from '@foreman-code/contracts/server-kit'",
    "import { status } from '../src/status.js'",
    "import { context } from './helpers/context.js'",
    "import { ownedTestPath } from '../../../scripts/test-resources.mjs'",
    "it('runs', () => expect([join, DomainError, status, context, ownedTestPath]).toHaveLength(5))",
  ].join('\n'))
  const result = f.run()
  assert.equal(result.status, 0, result.stderr)
})

for (const [name, text] of [
  ['an API module', "import { mainCiContext } from '../../api/src/modules/ci/context.js'"],
  ['an undeclared package', "import fastify from 'fastify'"],
  ['its own package by name', "import { status } from '@foreman-code/ci/status'"],
]) {
  test(`rejects a CI test import of ${name}`, t => {
    const f = fixture(t)
    f.write('apps/ci/test/extra.test.ts', text)
    const result = f.run()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /apps\/ci\/test\/extra\.test\.ts imports/)
  })
}

test('rejects API modules outside the adapter that import the CI package', t => {
  const f = fixture(t)
  f.write('apps/api/src/routes/hostCi.ts', "import type { CiAuthority } from '@foreman-code/ci/authority'\nexport type A = CiAuthority")
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /apps\/api\/src\/routes\/hostCi\.ts imports @foreman-code\/ci\/authority/)
})

test('rejects the adapter reaching CI source by relative path instead of the package', t => {
  const f = fixture(t)
  f.write('apps/api/src/modules/ci/runner.ts', "export { HostCiRunner } from '../../../../ci/src/runner.js'")
  const result = f.run()
  assert.equal(result.status, 1)
  assert.match(result.stderr, /apps\/api\/src\/modules\/ci\/runner\.ts imports \.\.\/\.\.\/\.\.\/\.\.\/ci\/src\/runner\.js/)
})

for (const file of ['apps/web/src/ciView.tsx', 'packages/contracts/src/ciHost.ts']) {
  test(`rejects ${file.split('/').slice(0, 2).join('/')} importing the CI package`, t => {
    const f = fixture(t)
    f.write(file, "import { status } from '@foreman-code/ci/status'\nexport { status }")
    const result = f.run()
    assert.equal(result.status, 1)
    assert.match(result.stderr, /never imports the CI package/)
  })
}

test('rejects CI dependencies the API lacks or pins at another version', t => {
  const missing = fixture(t, { ciDependencies: { yaml: '2.9.0' } }).run()
  assert.equal(missing.status, 1)
  assert.match(missing.stderr, /yaml@2\.9\.0 but apps\/api\/package\.json has no such dependency/)
  const skewed = fixture(t, { ciDependencies: { zod: '4.6.2' } }).run()
  assert.equal(skewed.status, 1)
  assert.match(skewed.stderr, /zod@4\.6\.2 but apps\/api\/package\.json has 4\.6\.3/)
})

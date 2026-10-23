import assert from 'node:assert/strict'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { test } from 'node:test'
import { boundaryProblems, crossModuleImports, currentViolations, pendingModuleText, relativeImports } from './check-api-module-boundaries.mjs'

const modules = 'apps/api/src/modules'

function fixture(t, files) {
  const cache = join(homedir(), '.cache', 'foreman-tmp')
  mkdirSync(cache, { recursive: true })
  const root = mkdtempSync(join(cache, 'api-module-boundaries-'))
  t.after(() => rmSync(root, { recursive: true, force: true }))
  for (const [path, text] of Object.entries(files)) {
    mkdirSync(dirname(join(root, modules, path)), { recursive: true })
    writeFileSync(join(root, modules, path), text)
  }
  return root
}

const none = { internalImports: new Set(), mutualPairs: new Set() }

test('relative imports include type-only, re-exported, bare and dynamic imports and skip packages', () => {
  const text = [
    "import { a } from './a.js'",
    "import type { B } from '../b/types.js'",
    "export * from './c.js'",
    "import './d.js'",
    "const lazy = await import('./e.js')",
    'import {\n  f,\n  g,\n} from "./f.js"',
    "import { z } from 'zod'",
    " * import { h } from './comment.js'",
  ].join('\n')
  assert.deepEqual(relativeImports(text), ['./a.js', '../b/types.js', './c.js', './d.js', './e.js', './f.js'])
})

test('a module may import another module only through its index', t => {
  const root = fixture(t, {
    'a/index.ts': "export { run } from './run.js'",
    'a/run.ts': 'export const run = 1',
    'b/use.ts': "import { run } from '../a/index.js'\nexport { run }",
    'c/use.ts': "import { run } from '../a/run.js'\nexport { run }",
    'c/own.ts': "export { use } from './use.js'",
    'errors.ts': 'export class Failure {}',
    'b/fail.ts': "import { Failure } from '../errors.js'\nexport { Failure }",
  })
  const violations = currentViolations(crossModuleImports(root))
  assert.deepEqual(violations, { entry: ['c>a/run.ts'], mutual: [] })
})

test('two modules that import each other are a mutual pair, whatever they import', t => {
  const root = fixture(t, {
    'a/index.ts': "export type { B } from '../b/index.js'",
    'b/index.ts': "export { a } from '../a/index.js'",
    'c/index.ts': "export { a } from '../a/index.js'",
  })
  assert.deepEqual(currentViolations(crossModuleImports(root)), { entry: [], mutual: ['a<>b'] })
})

test('tests and test helpers are not checked', t => {
  const root = fixture(t, {
    'a/run.ts': 'export const run = 1',
    'b/run.test.ts': "import { run } from '../a/run.js'\nexport { run }",
    'b/__tests__/run.ts': "import { run } from '../../a/run.js'\nexport { run }",
    'b/testing/fixture.ts': "import { run } from '../../a/run.js'\nexport { run }",
  })
  assert.deepEqual(currentViolations(crossModuleImports(root)), { entry: [], mutual: [] })
})

test('listed violations pass, new ones fail and fixed ones must leave the list', () => {
  const crossings = [
    { from: 'c', to: 'a', file: 'x', target: 'run.ts' },
    { from: 'd', to: 'a', file: 'x', target: 'other.ts' },
    { from: 'a', to: 'b', file: 'x', target: 'index.ts' },
    { from: 'b', to: 'a', file: 'x', target: 'index.ts' },
  ]
  const pending = { internalImports: new Set(['c>a/run.ts', 'e>a/gone.ts']), mutualPairs: new Set(['a<>f']) }
  assert.deepEqual(boundaryProblems(crossings, pending), {
    newEntry: ['d>a/other.ts'],
    newMutual: ['a<>b'],
    staleEntry: ['e>a/gone.ts'],
    staleMutual: ['a<>f'],
  })
  assert.deepEqual(boundaryProblems([], none), { newEntry: [], newMutual: [], staleEntry: [], staleMutual: [] })
})

test('the pending module lists each violation once, sorted', async () => {
  const text = pendingModuleText({ entry: ['c>a/run.ts'], mutual: ['a<>b'] })
  const loaded = await import(`data:text/javascript,${encodeURIComponent(text)}`)
  assert.deepEqual([...loaded.internalImports], ['c>a/run.ts'])
  assert.deepEqual([...loaded.mutualPairs], ['a<>b'])
})

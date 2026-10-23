import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boundaryViolations, compareWithPending, importSpecifiers } from './check-web-feature-boundaries.mjs'

const src = 'apps/web/src'
const modules = files => new Map(Object.entries(files).map(([path, text]) => [`${src}/${path}`, text]))

test('import specifiers cover static, type, re-export and dynamic imports but not typeof import types', () => {
  const text = [
    "import { a } from './a'",
    "import type { B } from '../b'",
    'import {\n  c,\n  d,\n} from "../c"',
    "export { e } from './e'",
    "import './side-effect'",
    "const lazy = await import('./lazy')",
    "type Original = typeof import('./original')",
    "import { external } from 'react'",
  ].join('\n')
  assert.deepEqual(importSpecifiers(text).sort(), ['../b', '../c', './a', './e', './lazy', './side-effect'])
})

test('a module reaches another feature only through its index', () => {
  const found = boundaryViolations(modules({
    'features/a/A.tsx': "import { index } from '../b'\nimport { inner } from '../b/inner'\nimport type { Deep } from '../b/deep/Thing'",
    'features/a/local.ts': "import { sibling } from './A'",
    'features/b/index.ts': "export { inner } from './inner'",
    'features/b/inner.ts': "import { local } from './deep/Thing'",
    'features/b/deep/Thing.ts': '',
    'routes/Route.tsx': "import { inner } from '../features/b/inner'\nimport { index } from '../features/b'",
  }))
  assert.deepEqual(found, [
    `${src}/features/a/A.tsx > ${src}/features/b/deep/Thing.ts`,
    `${src}/features/a/A.tsx > ${src}/features/b/inner.ts`,
    `${src}/routes/Route.tsx > ${src}/features/b/inner.ts`,
  ])
})

test('tests may import another feature test support but not its internals', () => {
  const found = boundaryViolations(modules({
    'features/a/A.test.tsx': "import { fixture } from '../b/b.fixtures'\nimport { support } from '../b/testSupport'\nimport { inner } from '../b/inner'",
    'features/a/A.tsx': "import { fixture } from '../b/b.fixtures'",
    'features/b/b.fixtures.ts': '',
    'features/b/testSupport.ts': '',
    'features/b/inner.ts': '',
  }))
  assert.deepEqual(found, [
    `${src}/features/a/A.test.tsx > ${src}/features/b/inner.ts`,
    `${src}/features/a/A.tsx > ${src}/features/b/b.fixtures.ts`,
  ])
})

test('the pending list may only shrink', () => {
  const pending = new Set(['a > b', 'c > d'])
  assert.deepEqual(compareWithPending(['a > b', 'e > f'], pending), { added: ['e > f'], stale: ['c > d'] })
  assert.deepEqual(compareWithPending(['a > b', 'c > d'], pending), { added: [], stale: [] })
})

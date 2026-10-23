import { pendingWebFeatureImports } from './web-feature-boundary-pending.mjs'
// Fails when web code imports another feature's internals instead of its index.
//   node scripts/check-web-feature-boundaries.mjs
// A feature is a directory in apps/web/src/features. Everything outside it (other features, app, routes, shared)
// reaches it only through features/<name>/index.ts. Imports between test files and test support modules (*.test.*,
// fixtures, testSupport, mocks) are exempt: those are not part of a feature's public surface.
// Imports that predate the check are listed in scripts/web-feature-boundary-pending.mjs. That list only shrinks:
// an import not on it fails, and so does a listed import that no longer violates the rule.
import { readdirSync, readFileSync } from 'node:fs'
import { dirname, posix } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = dirname(dirname(fileURLToPath(import.meta.url)))
export const webSource = 'apps/web/src'
const source = /\.(?:[cm]?ts|tsx)$/
const featureDirectory = new RegExp(`^${webSource}/features/([^/]+)/`)
const staticImport = /(?:^|[\n;])\s*(?:import|export)\b(?:\s+type\b)?[^'";]*?\bfrom\s*(['"])([^'"\n]+)\1|(?:^|[\n;])\s*import\s*(['"])([^'"\n]+)\3/g
const dynamicImport = /(?<!typeof\s)\bimport\(\s*(['"])([^'"\n]+)\1\s*\)/g

export const featureOf = file => featureDirectory.exec(file)?.[1]
export const isFeatureIndex = file => new RegExp(`^${webSource}/features/[^/]+/index\\.tsx?$`).test(file)
export const isTestSupport = file => /\.test\.[cm]?tsx?$/.test(file) || /\/fixtures\//.test(file)
  || /(test|fixture|mock|cases|support)/i.test(posix.basename(file))

/** Every relative import specifier of one module: static, re-export and dynamic `import()`. */
export function importSpecifiers(text) {
  const specifiers = []
  for (const match of text.matchAll(staticImport)) specifiers.push(match[2] ?? match[4])
  for (const match of text.matchAll(dynamicImport)) specifiers.push(match[2])
  return specifiers.filter(specifier => specifier.startsWith('.'))
}

/** `importer > target` pairs where a module reaches into another feature's internals. `modules` maps path to text. */
export function boundaryViolations(modules) {
  const violations = new Set()
  for (const [file, text] of modules) {
    for (const specifier of importSpecifiers(text)) {
      const stem = posix.join(posix.dirname(file), specifier).replace(/\.[cm]?js$/, '')
      const target = ['', '.ts', '.tsx', '.mts', '/index.ts', '/index.tsx'].map(extension => `${stem}${extension}`)
        .find(path => modules.has(path))
      const feature = target && featureOf(target)
      if (!feature || feature === featureOf(file) || isFeatureIndex(target)) continue
      if (isTestSupport(file) && isTestSupport(target)) continue
      violations.add(`${file} > ${target}`)
    }
  }
  return [...violations].sort()
}

/** Violations not on the pending list, and listed entries that no longer violate. */
export function compareWithPending(violations, pending) {
  const current = new Set(violations)
  return { added: violations.filter(entry => !pending.has(entry)), stale: [...pending].filter(entry => !current.has(entry)).sort() }
}

function sourceFiles(directory) {
  return readdirSync(`${root}/${directory}`, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    return entry.isDirectory() ? sourceFiles(path) : source.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name) ? [path] : []
  })
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const modules = new Map(sourceFiles(webSource).map(file => [file, readFileSync(`${root}/${file}`, 'utf8')]))
  const { added, stale } = compareWithPending(boundaryViolations(modules), pendingWebFeatureImports)
  if (added.length) {
    console.error(`Web code reaches into another feature's internals. Import from the feature's index instead (export it there if needed):`)
    for (const entry of added) console.error(`  ${entry}`)
  }
  if (stale.length) {
    console.error('These imports are fixed. Remove them from scripts/web-feature-boundary-pending.mjs (the list only shrinks):')
    for (const entry of stale) console.error(`  ${entry}`)
  }
  if (added.length || stale.length) process.exit(1)
}

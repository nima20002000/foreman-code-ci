// Fails when apps/api/src/modules/* break the module boundaries.
//   node scripts/check-api-module-boundaries.mjs [repository-root] [--prune]
// - A module imports another module only through its public entry, `modules/<name>/index.ts`.
// - Two modules never import each other.
// Both rules count every import in production files, type-only and dynamic imports included, because a type or a
// lazy load couples modules as much as a call does. Tests (`*.test.*`, `__tests__/`, `testing/`) are not checked.
// Files directly under `modules/` (errors.ts, ...) belong to no module and may be imported by any of them.
// Violations that predate the check are listed in scripts/api-module-boundaries-pending.mjs. That list only shrinks:
// never add a line. A listed violation that no longer exists fails the check; `--prune` deletes those lines.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, posix } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const scriptsDirectory = dirname(fileURLToPath(import.meta.url))
const defaultRoot = dirname(scriptsDirectory)
const modulesDirectory = 'apps/api/src/modules'
const source = /\.(?:[cm]?ts|tsx)$/
const nonProduction = /(?:\.test\.[cm]?tsx?$|\/__tests__\/|\/testing\/)/
const statement = /(?:^|\n)\s*(?:import|export)\s+(?:type\s+)?(?:[\w$*\s,]*(?:\{[^}]*\})?\s*from\s*)?['"]([^'"]+)['"]|\bimport\(\s*['"]([^'"]+)['"]\s*\)/g

/** Every relative module specifier of one file: static imports and re-exports, `import './x'` and `import('./x')`. */
export function relativeImports(text) {
  return [...text.matchAll(statement)].map(match => match[1] ?? match[2]).filter(specifier => specifier.startsWith('.'))
}

function sourceFiles(root, directory) {
  return readdirSync(`${root}/${directory}`, { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return entry.name === 'node_modules' ? [] : sourceFiles(root, path)
    return source.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name) ? [path] : []
  })
}

/** The module a repository-relative file belongs to, or undefined for files outside any module. */
export function moduleOf(file) {
  return new RegExp(`^${modulesDirectory}/([^/]+)/`).exec(file)?.[1]
}

/** Imports that cross from one module into another: `{ from, to, file, target }`, `target` relative to the module. */
export function crossModuleImports(root) {
  const files = new Set(sourceFiles(root, modulesDirectory))
  const crossings = []
  for (const file of [...files].sort()) {
    const from = moduleOf(file)
    if (!from || nonProduction.test(file)) continue
    for (const specifier of relativeImports(readFileSync(`${root}/${file}`, 'utf8'))) {
      const stem = posix.join(posix.dirname(file), specifier).replace(/\.[cm]?js$/, '')
      const target = ['', '.ts', '.tsx', '/index.ts'].map(suffix => `${stem}${suffix}`).find(path => files.has(path))
      const to = target && moduleOf(target)
      if (to && to !== from) crossings.push({ from, to, file, target: target.slice(`${modulesDirectory}/${to}/`.length) })
    }
  }
  return crossings
}

/** Current violations as sorted keys: `from>to/path` for an internal import, `a<>b` for a mutual pair. */
export function currentViolations(crossings) {
  const entry = new Set(), edges = new Set(), mutual = new Set()
  for (const { from, to, target } of crossings) {
    if (target !== 'index.ts') entry.add(`${from}>${to}/${target}`)
    edges.add(`${from}>${to}`)
  }
  for (const edge of edges) {
    const [from, to] = edge.split('>')
    if (from < to && edges.has(`${to}>${from}`)) mutual.add(`${from}<>${to}`)
  }
  return { entry: [...entry].sort(), mutual: [...mutual].sort() }
}

/** New violations (missing from the pending lists) and pending lines that no longer match anything. */
export function boundaryProblems(crossings, pending) {
  const current = currentViolations(crossings)
  const pendingEntry = new Set(pending.internalImports), pendingMutual = new Set(pending.mutualPairs)
  return {
    newEntry: current.entry.filter(key => !pendingEntry.has(key)),
    newMutual: current.mutual.filter(key => !pendingMutual.has(key)),
    staleEntry: [...pendingEntry].filter(key => !current.entry.includes(key)).sort(),
    staleMutual: [...pendingMutual].filter(key => !current.mutual.includes(key)).sort(),
  }
}

const listing = (name, keys) => `export const ${name} = new Set([\n${keys.map(key => `  '${key}',`).join('\n')}\n])\n`

/** Text of the pending-list module for the given violations. */
export function pendingModuleText({ entry, mutual }) {
  return [
    '// Module-boundary violations that predate scripts/check-api-module-boundaries.mjs. This list only shrinks:',
    '// route the import through the other module\'s index.ts or break the cycle, then delete its line.',
    '// Never add a line.',
    "// internalImports: 'importer>target/path.ts' is a module reaching into another module's internals.",
    "// mutualPairs: 'a<>b' are two modules that import each other.",
    listing('internalImports', entry),
    listing('mutualPairs', mutual),
  ].join('\n')
}

async function main() {
  const args = process.argv.slice(2)
  const prune = args.includes('--prune')
  const root = args.find(arg => !arg.startsWith('--')) ?? defaultRoot
  const pendingFile = `${scriptsDirectory}/api-module-boundaries-pending.mjs`
  const { internalImports, mutualPairs } = await import(pathToFileURL(pendingFile).href)
  const crossings = crossModuleImports(root)
  const problems = boundaryProblems(crossings, { internalImports, mutualPairs })
  const stale = problems.staleEntry.length + problems.staleMutual.length
  if (prune && stale) {
    const current = currentViolations(crossings)
    const keep = (list, kept) => list.filter(key => kept.has(key))
    writeFileSync(pendingFile, pendingModuleText({
      entry: keep(current.entry, internalImports), mutual: keep(current.mutual, mutualPairs),
    }))
    console.log(`Removed ${stale} fixed violation(s) from ${posix.relative(defaultRoot, pendingFile)}`)
    problems.staleEntry = []
    problems.staleMutual = []
  }
  const failures = []
  if (problems.newEntry.length) {
    failures.push('Modules must import another module only through its index.ts (export what callers need there):',
      ...problems.newEntry.map(key => `  ${key.replace('>', ' imports ')}`))
  }
  if (problems.newMutual.length) {
    failures.push('Modules must not import each other (move the shared code into a module or infrastructure both import):',
      ...problems.newMutual.map(key => `  ${key.replace('<>', ' <-> ')}`))
  }
  if (problems.staleEntry.length || problems.staleMutual.length) {
    failures.push('Fixed violations are still listed in scripts/api-module-boundaries-pending.mjs (run with --prune):',
      ...[...problems.staleEntry, ...problems.staleMutual].map(key => `  ${key}`))
  }
  if (failures.length) {
    console.error(failures.join('\n'))
    process.exit(1)
  }
}

if (process.argv[1] === fileURLToPath(import.meta.url)) await main()

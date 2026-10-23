// Fails when an import crosses the @foreman-code/ci package boundary.
//   node scripts/check-package-boundaries.mjs [repository-root]
// - apps/ci/src imports only its own modules, Node builtins, @foreman-code/contracts, its declared dependencies and
//   types from pg.
// - apps/ci/test imports only CI's own files, the repository's scripts, Node builtins, @foreman-code/contracts and CI's
//   declared dependencies and dev dependencies: CI's tests never load the API.
// - In apps/api/src only modules/ci/ (the adapter) imports @foreman-code/ci, and only by package name.
// - apps/worker/src reaches API code only through the entry points of @foreman-code/api (`@foreman-code/api/worker/<module>`),
//   never by relative path.
// - apps/web and packages/contracts never import the CI package.
// - Releases resolve CI's dependencies through the API's node_modules, so apps/ci dependencies are a subset of the
//   API's at identical versions.
import { existsSync, readdirSync, readFileSync } from 'node:fs'
import { createRequire, isBuiltin } from 'node:module'
import { dirname, join, posix, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const repositoryRoot = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const ts = createRequire(join(repositoryRoot, 'apps/api/package.json'))('typescript')
const source = /\.(?:[cm]?[jt]s|[jt]sx)$/
const adapter = 'apps/api/src/modules/ci/'

function sourceFiles(root, directory) {
  if (!existsSync(join(root, directory))) return []
  return readdirSync(join(root, directory), { withFileTypes: true }).flatMap(entry => {
    const path = `${directory}/${entry.name}`
    if (entry.isDirectory()) return ['node_modules', 'dist'].includes(entry.name) ? [] : sourceFiles(root, path)
    return source.test(entry.name) && !/\.d\.[cm]?ts$/.test(entry.name) ? [path] : []
  })
}

function typeOnly(node) {
  if (ts.isExportDeclaration(node)) {
    const clause = node.exportClause
    return node.isTypeOnly || Boolean(clause && ts.isNamedExports(clause) && clause.elements.length
      && clause.elements.every(element => element.isTypeOnly))
  }
  const clause = node.importClause
  if (!clause) return false
  const bindings = clause.namedBindings
  return clause.isTypeOnly || Boolean(!clause.name && bindings && ts.isNamedImports(bindings)
    && bindings.elements.length && bindings.elements.every(element => element.isTypeOnly))
}

/** Every literal module specifier of one file, and whether TypeScript erases it from the emitted module. */
export function moduleImports(file, text) {
  const found = []
  const visit = node => {
    if ((ts.isImportDeclaration(node) || ts.isExportDeclaration(node)) && node.moduleSpecifier
      && ts.isStringLiteralLike(node.moduleSpecifier)) {
      found.push({ specifier: node.moduleSpecifier.text, typeOnly: typeOnly(node) })
    } else if (ts.isImportEqualsDeclaration(node) && ts.isExternalModuleReference(node.moduleReference)
      && ts.isStringLiteralLike(node.moduleReference.expression)) {
      found.push({ specifier: node.moduleReference.expression.text, typeOnly: node.isTypeOnly })
    } else if (ts.isCallExpression(node) && node.arguments.length && ts.isStringLiteralLike(node.arguments[0])
      && (node.expression.kind === ts.SyntaxKind.ImportKeyword
        || (ts.isIdentifier(node.expression) && node.expression.text === 'require'))) {
      found.push({ specifier: node.arguments[0].text, typeOnly: false })
    } else if (ts.isImportTypeNode(node) && ts.isLiteralTypeNode(node.argument)
      && ts.isStringLiteral(node.argument.literal)) {
      found.push({ specifier: node.argument.literal.text, typeOnly: true })
    }
    ts.forEachChild(node, visit)
  }
  visit(ts.createSourceFile(file, text, ts.ScriptTarget.Latest))
  return found
}

const packageName = specifier => specifier.split('/').slice(0, specifier.startsWith('@') ? 2 : 1).join('/')
const target = (file, specifier) => posix.join(posix.dirname(file), specifier)
const namesCi = specifier => packageName(specifier) === '@foreman-code/ci'
const reachesCi = (file, specifier) => specifier.startsWith('.') && target(file, specifier).startsWith('apps/ci/')

/** Human-readable boundary violations in the repository at `root`; empty when the boundary holds. */
export function packageBoundaryViolations(root) {
  const read = path => readFileSync(join(root, path), 'utf8')
  const manifest = path => existsSync(join(root, path)) ? JSON.parse(read(path)) : {}
  const ci = manifest('apps/ci/package.json'), api = manifest('apps/api/package.json')
  const declared = new Set(Object.keys(ci.dependencies ?? {}))
  const testDeclared = new Set([...declared, ...Object.keys(ci.devDependencies ?? {})])
  const violations = []
  const imports = file => moduleImports(file, read(file))
  for (const file of sourceFiles(root, 'apps/ci/src')) for (const { specifier, typeOnly } of imports(file)) {
    const name = packageName(specifier)
    const allowed = specifier.startsWith('.') ? target(file, specifier).startsWith('apps/ci/src/')
      : isBuiltin(specifier) || name === '@foreman-code/contracts' || (typeOnly && name === 'pg')
        || (declared.has(name) && name !== '@foreman-code/ci')
    if (!allowed) violations.push(`${file} imports ${specifier}: apps/ci/src imports only its own modules, Node `
      + 'builtins, @foreman-code/contracts, its declared dependencies and types from pg')
  }
  for (const file of sourceFiles(root, 'apps/ci/test')) for (const { specifier } of imports(file)) {
    const name = packageName(specifier)
    const allowed = specifier.startsWith('.')
      ? ['apps/ci/', 'scripts/'].some(prefix => target(file, specifier).startsWith(prefix))
      : isBuiltin(specifier) || name === '@foreman-code/contracts' || (testDeclared.has(name) && name !== '@foreman-code/ci')
    if (!allowed) violations.push(`${file} imports ${specifier}: apps/ci/test imports only CI's own files, the `
      + "repository's scripts, Node builtins, @foreman-code/contracts and CI's declared dependencies")
  }
  for (const file of sourceFiles(root, 'apps/api/src')) for (const { specifier } of imports(file)) {
    if (reachesCi(file, specifier)) violations.push(`${file} imports ${specifier}: import the CI package by name`)
    else if (namesCi(specifier) && !file.startsWith(adapter)) {
      violations.push(`${file} imports ${specifier}: only ${adapter} imports the CI package`)
    }
  }
  for (const file of sourceFiles(root, 'apps/worker/src')) for (const { specifier } of imports(file)) {
    if (specifier.startsWith('.') && target(file, specifier).startsWith('apps/api/')) {
      violations.push(`${file} imports ${specifier}: import API code through @foreman-code/api/worker/<module>`)
    }
  }
  for (const directory of ['apps/web', 'packages/contracts']) {
    for (const file of sourceFiles(root, directory)) for (const { specifier } of imports(file)) {
      if (namesCi(specifier) || reachesCi(file, specifier)) {
        violations.push(`${file} imports ${specifier}: ${directory} never imports the CI package`)
      }
    }
  }
  for (const [name, version] of Object.entries(ci.dependencies ?? {})) {
    const own = api.dependencies?.[name]
    if (own !== version) violations.push(`apps/ci/package.json depends on ${name}@${version} but apps/api/package.json `
      + `has ${own === undefined ? 'no such dependency' : own}: CI dependencies are API dependencies at identical versions`)
  }
  return violations
}

if (process.argv[1] === fileURLToPath(import.meta.url)) {
  const violations = packageBoundaryViolations(resolve(process.argv[2] ?? repositoryRoot))
  if (violations.length) {
    console.error('CI package boundary violations:')
    for (const violation of violations) console.error(`  ${violation}`)
    process.exitCode = 1
  }
}

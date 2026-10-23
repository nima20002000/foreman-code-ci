// Regenerates docs/architecture/database-functions.md from the migration registry: where each PL/pgSQL function and
// trigger is currently defined (its last definition in migration order) and which error codes raised by SQL
// functions are also raised in TypeScript. Run from apps/api: `node --import tsx scripts/database-functions-doc.mjs`.
import { readdirSync, readFileSync, writeFileSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const api = resolve(dirname(fileURLToPath(import.meta.url)), '..')
const repo = resolve(api, '../..')
const output = join(repo, 'docs/architecture/database-functions.md')

const walk = directory => readdirSync(directory, { withFileTypes: true }).flatMap(entry => {
  const path = join(directory, entry.name)
  return entry.isDirectory() ? walk(path) : [path]
})
// CI-owned migrations live in the CI package; the registry imports them from its built output.
const sources = [...walk(join(api, 'src')), ...walk(join(repo, 'apps/ci/src/migrations'))].filter(path => path.endsWith('.ts') && !/\.test\.|test-?support/i.test(path))
const migrationModules = sources.filter(path => /migration/i.test(path.split('/').at(-1)) && !path.endsWith('modules/ci/migrations.ts'))
const registryPath = join(api, 'src/infrastructure/migrations.ts')
const { migrations } = await import(pathToFileURL(registryPath).href)

// The module that declares each registered migration object or its SQL string; inline entries live in the registry.
const owners = new Map()
for (const path of migrationModules) {
  if (path === registryPath) continue
  const module = await import(pathToFileURL(path).href)
  for (const value of Object.values(module)) {
    if (value && typeof value === 'object' && typeof value.sql === 'string') { owners.set(value, path); owners.set(value.sql, path) }
    if (typeof value === 'string') owners.set(value, path)
  }
}
const ownerOf = migration => relative(repo, owners.get(migration) ?? owners.get(migration.sql) ?? registryPath)

const identifier = /("?[\w]+"?\.)?"?([\w]+)"?/
const plainName = text => text.match(identifier)?.[2]?.toLowerCase()
const functions = new Map()
const triggers = new Map()
// Only a code the function raises counts: SQL that uses a code as data (a default written into a record) duplicates no rule.
const codePattern = /raise\s+exception\s+'([A-Z][A-Z0-9]*(?:_[A-Z0-9]+)+)'/gi

for (const [order, migration] of migrations.entries()) {
  const sql = migration.sql.replace(/--[^\n]*/g, '')
  const location = { version: migration.version, order, file: ownerOf(migration) }
  for (const match of sql.matchAll(/\bcreate\s+(?:or\s+replace\s+)?function\s+([\w."]+)\s*\(/gi)) {
    const name = plainName(match[1])
    const rest = sql.slice(match.index)
    const tag = rest.match(/\bas\s+(\$\w*\$)/i)
    const start = tag ? rest.indexOf(tag[1], tag.index) + tag[1].length : -1
    const body = tag ? rest.slice(start, rest.indexOf(tag[1], start)) : ''
    const previous = functions.get(name)
    functions.set(name, { ...location, definitions: (previous?.definitions ?? 0) + 1, dropped: false,
      codes: [...new Set([...body.matchAll(codePattern)].map(code => code[1]))] })
  }
  for (const match of sql.matchAll(/\bdrop\s+function\s+(?:if\s+exists\s+)?([\w."]+)/gi)) {
    const current = functions.get(plainName(match[1]))
    if (current && current.version !== migration.version) current.dropped = location
  }
  for (const match of sql.matchAll(/\bcreate\s+(?:or\s+replace\s+)?(?:constraint\s+)?trigger\s+([\w"]+)([\s\S]*?)\bexecute\s+(?:function|procedure)\s+([\w."]+)/gi)) {
    const table = match[2].match(/\bon\s+([\w."]+)/i)?.[1]
    const key = `${plainName(match[1])} on ${plainName(table ?? '?')}`
    const previous = triggers.get(key)
    triggers.set(key, { ...location, definitions: (previous?.definitions ?? 0) + 1, dropped: false,
      function: plainName(match[3]) })
  }
  for (const match of sql.matchAll(/\bdrop\s+trigger\s+(?:if\s+exists\s+)?([\w"]+)\s+on\s+([\w."]+)/gi)) {
    const current = triggers.get(`${plainName(match[1])} on ${plainName(match[2])}`)
    if (current && current.version !== migration.version) current.dropped = location
  }
}

// Error codes raised by a current SQL function and also raised or matched in TypeScript outside migrations.
// The mapper translates SQL failures; it does not duplicate their validation rules.
const typescript = sources.filter(path => !migrationModules.includes(path)
  && path !== join(api, 'src/infrastructure/databaseErrors.ts'))
  .map(path => ({ path: relative(repo, path), text: readFileSync(path, 'utf8') }))
const duplicated = new Map()
for (const [name, fn] of functions) {
  if (fn.dropped) continue
  for (const code of fn.codes) {
    const files = typescript.filter(file => file.text.includes(`'${code}'`)).map(file => file.path)
    if (!files.length) continue
    const entry = duplicated.get(code) ?? { functions: new Set(), files }
    entry.functions.add(name)
    duplicated.set(code, entry)
  }
}

const where = item => `${item.version} (\`${item.file}\`)`
const sorted = map => [...map].sort(([left], [right]) => left.localeCompare(right))
const liveFunctions = sorted(functions).filter(([, fn]) => !fn.dropped)
const liveTriggers = sorted(triggers).filter(([, trigger]) => !trigger.dropped)
const lines = [
  '# Database functions and triggers',
  '',
  'Generated by `apps/api/scripts/database-functions-doc.mjs` from the migration registry',
  '(`apps/api/src/infrastructure/migrations.ts`); regenerate it after adding a migration that defines or drops a',
  'function or trigger: `cd apps/api && node --import tsx scripts/database-functions-doc.mjs`.',
  '',
  'Migrations run in registry order and a later `create or replace` wins, so the **current definition** of each',
  'object is its last definition in that order, listed below as migration version and source file. Edit behavior',
  'only by appending a new migration; never change an applied migration. Objects created through dynamic SQL',
  '(`execute format(...)`) are not detected.',
  '',
  `Current: ${liveFunctions.length} functions, ${liveTriggers.length} triggers.`,
  '',
  '## Functions',
  '',
  '| Function | Current definition | Definitions |',
  '|---|---|---|',
  ...liveFunctions.map(([name, fn]) => `| \`${name}\` | ${where(fn)} | ${fn.definitions} |`),
  '',
  '## Triggers',
  '',
  '| Trigger | Function | Current definition | Definitions |',
  '|---|---|---|---|',
  ...liveTriggers.map(([name, trigger]) => `| \`${name}\` | \`${trigger.function}\` | ${where(trigger)} | ${trigger.definitions} |`),
  '',
  '## Rules enforced in both SQL and TypeScript',
  '',
  'Error codes that a current SQL function raises (`raise exception \'CODE\'`) and TypeScript also throws or matches.',
  'SQL that only uses a code as data (a default written into a record) is not listed: it duplicates no rule.',
  '',
  'Decision (#25): the SQL function is the canonical home of each rule, because a trigger holds for every writer.',
  '`infrastructure/databaseErrors.ts` maps the 25 known raised codes to safe 409 `DomainError`s at the owning',
  '`withTransaction` boundary, after rollback/recovery. Unknown errors keep their identity. Joined work leaves',
  'mapping to its transaction owner. The write path no longer revalidates its computed repeat decision and successor;',
  'SQL validates those at COMMIT. TypeScript retains parsing, computation, read-side evidence checks and pre-checks',
  'whose callers recover within the same transaction. Matching a code alone does not make a check redundant.',
  '',
  '| Code | SQL functions | TypeScript |',
  '|---|---|---|',
  ...sorted(duplicated).map(([code, entry]) => `| \`${code}\` | ${[...entry.functions].sort().map(name => `\`${name}\``).join(', ')} | ${entry.files.map(file => `\`${file}\``).join('<br>')} |`),
  '',
  '## Dropped',
  '',
  ...[...sorted(functions).filter(([, fn]) => fn.dropped).map(([name, fn]) => `- function \`${name}\`: dropped in ${where(fn.dropped)}`),
    ...sorted(triggers).filter(([, trigger]) => trigger.dropped).map(([name, trigger]) => `- trigger \`${name}\`: dropped in ${where(trigger.dropped)}`)],
  '',
]
writeFileSync(output, lines.join('\n'))
console.log(`Wrote ${relative(repo, output)}: ${liveFunctions.length} functions, ${liveTriggers.length} triggers, ${duplicated.size} shared codes.`)

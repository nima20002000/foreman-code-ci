// Local lint rules for patterns earlier changes kept producing. Each package config ends with
// `...foremanLint(import.meta.dirname)`. Files listed in scripts/lint-allowlist.json predate a rule and are exempt
// from it; that list may only shrink (scripts/lint-baseline.mjs prunes it).
import { resolveLintAllowlist } from '../lint-allowlist.mjs'
import { pendingSqlTextTests } from './pendingSqlTextTests.mjs'
import { readFileSync } from 'node:fs'
import { dirname, relative, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'

const root = resolve(dirname(fileURLToPath(import.meta.url)), '../..')

const name = node => node?.type === 'Identifier' ? node.name
  : node?.type === 'MemberExpression' && !node.computed ? node.property.name
    : node?.type === 'ChainExpression' ? name(node.expression) : undefined

function literalText(node) {
  if (node?.type === 'Literal' && typeof node.value === 'string') return node.value
  if (node?.type === 'TemplateLiteral') return node.quasis[0].value.cooked ?? ''
  return undefined
}

function numberValue(node) {
  if (node?.type === 'Literal' && typeof node.value === 'number') return node.value
  if (node?.type === 'BinaryExpression' && node.operator === '*') {
    const left = numberValue(node.left), right = numberValue(node.right)
    return left === undefined || right === undefined ? undefined : left * right
  }
  return undefined
}

const ignoreComment = (sourceCode, node) => sourceCode.getCommentsInside(node)
  .some(comment => comment.value.trim().replace(/^\*\s*/, '').startsWith('ignore:'))

const rule = (description, message, create) => ({
  meta: { type: 'problem', docs: { description }, schema: [], messages: { problem: message } },
  create,
})

const sourcePath = /\.(?:[cm]?ts|tsx|mjs)$/
const sqlName = /(?:sql|statements?|quer(?:y|ies))$/i
const textMatchers = new Set(['toBe', 'toEqual', 'toStrictEqual', 'toContain', 'toMatch'])

// SQL statements, clauses and fragments. A test that compares text against one of these is routing a fake database
// on SQL text or asserting on SQL text, whatever the compared value is called. Keywords count in lower or upper case,
// never Title case, so English such as "Select files from disk" is not SQL.
const sqlPatterns = [
  /(?:^|[(\s])select\s+(?:distinct\s+)?(?:[*(\d]|[a-z]\w*(?:_\w|\.\w|\s*,|\s*\(|\s+from\s|\s+as\s|::|->|#>))/,
  /\binsert\s+into\s+["a-z]/,
  /(?:^|[(;]\s*)update\s+(?:[a-z]\w*_\w|[a-z]\w*(?:\s+[a-z]\w*)?\s+set\b)/,
  /\bdelete\s+from\s+["a-z]/,
  /\bfor\s+(?:no\s+key\s+)?update(?:\s+of\s|\s+skip\s+locked|\s+nowait|\s*\)|\s*$)/,
  /\b(?:from|join)\s+[a-z]+_[a-z_]+\b/,
  /\bon\s+conflict\b/,
  /\b[a-z]\w*(?:_|\.)\w*\s+is\s+(?:not\s+)?null\b/,
  /\bvalues\s*\(\s*\$\d/,
  /\b(?:where|and|or|set)\s+[a-z][\w.]*\s*(?:=|<>|!=|>=?|<=?|in\b|is\b|any\b)\s*\(?\s*\$\d/,
  /\bpg_(?:advisory|try_advisory|notify|sleep|stat_activity|locks|class|catalog|tables)/,
  /^with\s+(?:recursive\s+)?[a-z]\w*\s+as\s*\(/,
  /^(?:create|alter|drop)\s+(?:table|(?:unique\s+)?index|schema|view|function|trigger|type|extension|sequence)\b/,
  /::(?:jsonb?|text|uuid|bigint|int|integer|timestamptz|numeric|boolean)\b/,
  /^(?:begin\s+isolation|set\s+(?:local|transaction)\s|lock\s+table\s|truncate\s+(?:table\s+)?[a-z])/,
  /\border\s+by\s+(?:[a-z]\w*\.[a-z]\w*|[a-z]\w*\s+(?:asc|desc|limit|nulls)\b)/,
]
const sqlText = text => {
  const normal = text.replace(/\s+/g, ' ').trim().replace(/\b[A-Z][A-Z_]*\b/g, word => word.toLowerCase())
  return sqlPatterns.some(pattern => pattern.test(normal))
}
const regexText = ({ pattern, flags }) => {
  const text = pattern.replace(/\\s[+*]?\??/g, ' ').replace(/\\b|\^|\$(?!\d)/g, '').replace(/\\(.)/g, '$1')
  return flags.includes('i') ? text.toLowerCase() : text
}
/** The text a literal, template or regular expression compares against, when it is written in place. */
function comparedText(node) {
  if (node?.type === 'Literal' && node.regex) return regexText(node.regex)
  if (node?.type === 'TemplateLiteral') return node.quasis.map(quasi => quasi.value.cooked ?? '').join(' ')
  return literalText(node)
}
const comparesSql = node => {
  const text = comparedText(node)
  return text !== undefined && sqlText(text)
}
const comparesSqlDeep = node => comparesSql(node)
  || (node?.type === 'ArrayExpression' && node.elements.some(element => comparesSql(element)))
const stringSearches = new Set(['startsWith', 'endsWith', 'includes', 'indexOf', 'lastIndexOf', 'match', 'matchAll', 'search'])
const sqlMatchers = new Set([...textMatchers, 'toContainEqual', 'toHaveBeenCalledWith', 'toHaveBeenNthCalledWith',
  'toHaveBeenLastCalledWith', 'toBeCalledWith'])

const rules = {
  'no-source-text-tests': {
    meta: {
      type: 'problem',
      docs: { description: 'Tests assert behavior, not the text of repository source files or SQL.' },
      schema: [{ type: 'object', properties: { pendingSqlText: { type: 'boolean' } }, additionalProperties: false }],
      messages: {
        problem: 'Assert behavior through a public interface (rendered UI, HTTP/MCP response, function result, persisted data), not source or SQL text.',
        stale: 'This file no longer compares SQL text; remove it from scripts/eslint-plugin-foreman/pendingSqlTextTests.mjs.',
      },
    },
    create: context => {
      // `pendingSqlText` marks a file from the shrinking list of tests that still compare SQL text (see foremanLint).
      const pending = context.options[0]?.pendingSqlText === true
      let sqlComparisons = 0
      const sqlComparison = node => {
        sqlComparisons++
        if (!pending) context.report({ node, messageId: 'problem' })
      }
      return {
        'Program:exit'(node) {
          if (pending && sqlComparisons === 0) context.report({ node, messageId: 'stale' })
        },
        BinaryExpression(node) {
          if (['===', '!==', '==', '!='].includes(node.operator) && (comparesSql(node.left) || comparesSql(node.right))) sqlComparison(node)
        },
        SwitchCase(node) {
          if (comparesSql(node.test)) sqlComparison(node)
        },
        ImportDeclaration(node) {
          if (/[?&]raw$/.test(node.source.value)) context.report({ node, messageId: 'problem' })
        },
        CallExpression(node) {
          const callee = name(node.callee)
          if ((callee === 'readFile' || callee === 'readFileSync') && node.arguments[0]) {
            const strings = []
            const collect = value => {
              if (!value || typeof value !== 'object') return
              if (Array.isArray(value)) return value.forEach(collect)
              if (value.type === 'Literal' && typeof value.value === 'string') strings.push(value.value)
              else if (value.type === 'TemplateElement') strings.push(value.value.cooked ?? '')
              for (const [key, child] of Object.entries(value)) if (key !== 'parent' && key !== 'loc' && key !== 'range') collect(child)
            }
            collect(node.arguments[0])
            if (strings.some(text => sourcePath.test(text.trim()))) context.report({ node, messageId: 'problem' })
            return
          }
          if (name(node.callee.type === 'MemberExpression' ? node.callee.object : node.callee) === 'assert'
            && node.arguments.some(comparesSqlDeep)) return sqlComparison(node)
          if (node.callee.type !== 'MemberExpression') return
          const method = name(node.callee)
          if (stringSearches.has(method) && comparesSql(node.arguments[0])) return sqlComparison(node)
          if ((method === 'test' || method === 'exec') && node.callee.object.type === 'Literal' && comparesSql(node.callee.object)) return sqlComparison(node)
          if ((method === 'stringContaining' || method === 'stringMatching') && name(node.callee.object) === 'expect'
            && comparesSql(node.arguments[0])) return sqlComparison(node)
          if (!sqlMatchers.has(method)) return
          let subject = node.callee.object
          if (name(subject) === 'not' && subject.type === 'MemberExpression') subject = subject.object
          if (subject.type !== 'CallExpression' || name(subject.callee) !== 'expect') return
          if (node.arguments.some(comparesSqlDeep)) return sqlComparison(node)
          if (!textMatchers.has(method)) return
          const actual = subject.arguments[0]
          const actualName = actual && ['Identifier', 'MemberExpression', 'ChainExpression'].includes(actual.type) ? name(actual) : undefined
          if (actualName && sqlName.test(actualName)) context.report({ node, messageId: 'problem' })
        },
      }
    },
  },

  'no-local-canonical-json': rule('Canonical JSON comes from the one shared module.',
    'Use the shared canonical JSON module instead of a local canonical/stable JSON helper.',
    context => {
      if (context.filename.includes('canonicalJson')) return {}
      const pattern = /^(?:canonical|stable).*(?:json|stringify|serialize)/i
      const check = (node, id) => { if (id?.type === 'Identifier' && pattern.test(id.name)) context.report({ node, messageId: 'problem' }) }
      return {
        FunctionDeclaration: node => check(node, node.id),
        VariableDeclarator: node => check(node, node.id),
      }
    }),

  'no-raw-transactions': rule('Transactions go through the shared transaction helper.',
    'Use the shared transaction helper instead of sending BEGIN/COMMIT/ROLLBACK yourself.',
    context => ({
      CallExpression(node) {
        if (name(node.callee) !== 'query') return
        const text = literalText(node.arguments[0])
        if (text !== undefined && /^\s*(?:begin|commit|rollback|start\s+transaction)\b/i.test(text)) {
          context.report({ node, messageId: 'problem' })
        }
      },
    })),

  'no-raw-database-pools': rule('PostgreSQL pools and connections come from the pool factory.',
    'Create PostgreSQL pools and connections through infrastructure/pool.ts (createPool, createAuxiliaryPool, createDedicatedClient) so connection limits, deadlines and error handling apply.',
    context => {
      const modules = new Set(), constructors = new Set()
      const pgClass = name => name === 'Pool' || name === 'Client'
      return {
        ImportDeclaration(node) {
          if (node.source.value !== 'pg') return
          for (const specifier of node.specifiers) {
            if (specifier.type === 'ImportSpecifier') {
              if (pgClass(specifier.imported.name ?? specifier.imported.value)) constructors.add(specifier.local.name)
            } else modules.add(specifier.local.name)
          }
        },
        NewExpression(node) {
          const callee = node.callee
          if ((callee.type === 'Identifier' && constructors.has(callee.name))
            || (callee.type === 'MemberExpression' && !callee.computed && callee.object.type === 'Identifier'
              && modules.has(callee.object.name) && pgClass(callee.property.name))) {
            context.report({ node, messageId: 'problem' })
          }
        },
      }
    }),

  'no-silent-catch': rule('Errors are logged or rethrown, not discarded.',
    'Handle or log the error; if discarding it is right, say why in a comment starting with "ignore:".',
    context => {
      const discards = fn => (fn?.type === 'ArrowFunctionExpression' || fn?.type === 'FunctionExpression')
        && (fn.body.type === 'BlockStatement' ? fn.body.body.length === 0
          : (fn.body.type === 'Identifier' && fn.body.name === 'undefined')
            || (fn.body.type === 'Literal' && fn.body.value === null)
            || (fn.body.type === 'UnaryExpression' && fn.body.operator === 'void' && fn.body.argument.type === 'Literal'))
      return {
        CallExpression(node) {
          if (node.callee.type === 'MemberExpression' && name(node.callee) === 'catch' && discards(node.arguments[0])
            && !ignoreComment(context.sourceCode, node.arguments[0])) context.report({ node, messageId: 'problem' })
        },
        CatchClause(node) {
          if (node.body.body.length === 0 && !ignoreComment(context.sourceCode, node.body)) {
            context.report({ node, messageId: 'problem' })
          }
        },
      }
    }),

  'no-error-rewrap-without-cause': rule('A caught error that is replaced by a new error stays reachable as its cause.',
    'Pass the caught error as `cause` (for example `new XError(message, { cause: error })`), or rethrow it.',
    context => {
      // Only the catch's own body counts; a nested function or catch handles its own errors.
      const thrownNew = (node, found = []) => {
        if (!node || typeof node !== 'object') return found
        if (Array.isArray(node)) { node.forEach(child => thrownNew(child, found)); return found }
        if (['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ClassBody', 'CatchClause'].includes(node.type)) return found
        if (node.type === 'ThrowStatement' && node.argument?.type === 'NewExpression') found.push(node.argument)
        for (const [key, child] of Object.entries(node)) if (key !== 'parent') thrownNew(child, found)
        return found
      }
      const keepsCause = (created, caught) => created.arguments.some(argument =>
        (argument.type === 'Identifier' && (argument.name === caught || argument.name === 'cause'))
        || (argument.type === 'ArrayExpression' && argument.elements.some(element => element?.type === 'Identifier' && element.name === caught))
        || (argument.type === 'NewExpression' && keepsCause(argument, caught))
        || (argument.type === 'ObjectExpression' && argument.properties.some(property =>
          property.type === 'SpreadElement' || name(property.key) === 'cause')))
      // An unbound `catch {}` discards the error on purpose; a bound one that throws a replacement must keep it.
      const check = (body, param) => {
        if (param?.type !== 'Identifier') return
        const caught = param.name
        for (const created of thrownNew(body)) {
          if (!keepsCause(created, caught) && !ignoreComment(context.sourceCode, created)) {
            context.report({ node: created, messageId: 'problem' })
          }
        }
      }
      return {
        CatchClause(node) { check(node.body, node.param) },
        CallExpression(node) {
          const callback = node.arguments[0]
          if (node.callee.type === 'MemberExpression' && name(node.callee) === 'catch'
            && (callback?.type === 'ArrowFunctionExpression' || callback?.type === 'FunctionExpression')
            && callback.body.type === 'BlockStatement') check(callback.body.body, callback.params[0])
        },
      }
    }),

  'no-legacy-execution-semantics': rule('Only execution semantics 3 is executable.',
    'Execution semantics 1 and 2 are retired; do not branch on them.',
    context => {
      const isField = node => name(node) === 'executionSemanticsVersion'
      const isLegacy = node => node?.type === 'Literal' && (node.value === 1 || node.value === 2)
      return {
        BinaryExpression(node) {
          if (!['==', '===', '!=', '!==', '<', '<=', '>', '>='].includes(node.operator)) return
          if ((isField(node.left) && isLegacy(node.right)) || (isField(node.right) && isLegacy(node.left))) {
            context.report({ node, messageId: 'problem' })
          }
        },
        SwitchCase(node) {
          if (isLegacy(node.test) && isField(node.parent.discriminant)) context.report({ node, messageId: 'problem' })
        },
      }
    }),

  'test-timeout-limit': rule('Unit tests and hooks finish within 30 seconds.',
    'Unit test and hook timeouts stay at or below 30000 ms; move slow work to an integration test or make it faster.',
    context => ({
      CallExpression(node) {
        const callee = node.callee.type === 'MemberExpression' ? node.callee.object : node.callee
        if (!['it', 'test', 'describe', 'beforeEach', 'beforeAll', 'afterEach', 'afterAll'].includes(name(callee))) return
        const timeouts = node.arguments.slice(1).flatMap(argument => argument.type === 'ObjectExpression'
          ? argument.properties.filter(property => property.type === 'Property' && name(property.key) === 'timeout').map(property => property.value)
          : [argument])
        if (timeouts.some(value => (numberValue(value) ?? 0) > 30_000)) context.report({ node, messageId: 'problem' })
      },
    })),
}

export const plugin = { meta: { name: 'eslint-plugin-foreman' }, rules }

const tests = ['**/*.test.*', '**/*.spec.*', '**/test/**', '**/tests/**', '**/__tests__/**']

/** Config objects for one package directory: every rule is an error, minus that package's allowlisted files. */
export function foremanLint(directory) {
  const allowlist = resolveLintAllowlist(root, JSON.parse(readFileSync(resolve(root, 'scripts/lint-allowlist.json'), 'utf8')))
  const prefix = `${relative(root, directory)}/`
  const pendingSql = [...pendingSqlTextTests].filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length))
  const exemptions = process.env.FOREMAN_LINT_BASELINE === '1' ? [] : Object.entries(allowlist.eslint).flatMap(([id, files]) => {
    const local = files.filter(file => file.startsWith(prefix)).map(file => file.slice(prefix.length))
    return local.length ? [{ files: local, rules: { [id]: 'off' } }] : []
  })
  return [
    {
      plugins: { foreman: plugin },
      rules: {
        'foreman/no-local-canonical-json': 'error',
        'foreman/no-raw-transactions': 'error',
        'foreman/no-silent-catch': 'error',
        'foreman/no-legacy-execution-semantics': 'error',
      },
    },
    // The shared transaction helper is the one module that sends BEGIN/COMMIT/ROLLBACK.
    { files: ['src/infrastructure/transaction.ts'], rules: { 'foreman/no-raw-transactions': 'off' } },
    // The pool factory is the one module that constructs PostgreSQL pools and connections; tests build their own.
    { ignores: [...tests, '**/*.testSupport.*', '**/*.test-support.*'], rules: { 'foreman/no-raw-database-pools': 'error' } },
    { files: ['src/infrastructure/pool.ts'], rules: { 'foreman/no-raw-database-pools': 'off' } },
    { ignores: tests, rules: { 'foreman/no-error-rewrap-without-cause': 'error' } },
    { files: tests, rules: { 'foreman/no-source-text-tests': 'error' } },
    // Options are part of ESLint's cache key, so shrinking the list re-lints the files that left it.
    ...(pendingSql.length ? [{ files: pendingSql, rules: { 'foreman/no-source-text-tests': ['error', { pendingSqlText: true }] } }] : []),
    { files: ['src/**/*.test.*'], rules: { 'foreman/test-timeout-limit': 'error' } },
    ...exemptions,
  ]
}

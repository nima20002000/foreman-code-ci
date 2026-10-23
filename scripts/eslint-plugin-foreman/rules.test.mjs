import { createRequire } from 'node:module'
import { describe, it } from 'node:test'
import { plugin } from './index.mjs'

// The repository root has no ESLint of its own; every package pins the same version.
const { RuleTester } = createRequire(new URL('../../apps/api/package.json', import.meta.url))('eslint')
RuleTester.describe = describe
RuleTester.it = it
RuleTester.itOnly = it.only

const tester = new RuleTester({ languageOptions: { ecmaVersion: 2024, sourceType: 'module' } })
const problem = [{ messageId: 'problem' }]
const run = (id, valid, invalid) => tester.run(id, plugin.rules[id], {
  valid, invalid: invalid.map(code => typeof code === 'string' ? { code, errors: problem } : { errors: problem, ...code }),
})

run('no-source-text-tests', [
  "const output = readFileSync(join(directory, 'result.json'), 'utf8'); expect(JSON.parse(output)).toEqual({ ok: true })",
  "copyFileSync(new URL('../scripts/run.mjs', import.meta.url), target)",
  "import data from './fixture.json'",
  'expect(sql.updateCount).toBe(1)',
  'expect(result.rows).toEqual([])',
  "expect(sql).toHaveBeenCalledTimes(1)",
  "expect(screen.getByRole('button').textContent).toBe('Select files from disk')",
  "expect(message).toContain('Update the workflow and select an agent')",
  "if (event.type === 'run_started') count++",
  "expect(args).toEqual(['commit', '-m', 'update readme'])",
  "await pool.query('select id from runs where id = $1', [id])",
  "await pool.query(`insert into runs (id) values ($1)`, [id])",
  // A pending file still compares SQL text and says so through the rule option.
  { code: "if (text.startsWith('select record from runs')) rows = [run]", options: [{ pendingSqlText: true }] },
], [
  "const text = readFileSync(new URL('./service.ts', import.meta.url), 'utf8')",
  "const text = await readFile(path.join(root, 'src/routes.tsx'), 'utf8')",
  "const text = await fs.readFile(`${root}/scripts/ci-suite.mjs`, 'utf8')",
  "import source from './service.ts?raw'",
  "expect(sql).toContain('FOR UPDATE')",
  "expect(statements[1]?.sql).toMatch(/INSERT/)",
  "expect(insertStatement).toBe('INSERT INTO runs')",
  "expect(client.query).not.toEqual('BEGIN')",
  // SQL text is SQL text whatever the compared value is called.
  "expect(q).toContain('for update of e')",
  "expect(captured[0]).toMatch(/select .* from harness_executions/)",
  "expect(text).not.toContain('ON CONFLICT DO NOTHING')",
  "if (text.startsWith('select record,input_json from run_repeat_occurrences')) rows = []",
  "if (q.includes('from runs r join workflow_versions')) rows = []",
  "const routed = statement.includes(`insert into harness_executions`)",
  "if (/^\\s*update\\s+runs\\s+set/i.test(text)) rows = []",
  "if (text.match(/delete from interactions/)) rows = []",
  "if (q === 'select pg_advisory_xact_lock($1)') rows = []",
  "switch (text) { case 'select id from runs where id=$1': rows = [] }",
  "expect(query).toHaveBeenCalledWith('update runs set state=$2 where id=$1', ['run', 'stopped'])",
  "expect(calls).toEqual(['begin isolation level serializable', 'select 1 from runs for update'])",
  "expect(query.mock.calls[0][0]).toEqual(expect.stringContaining('where e.run_id=$1'))",
  "assert.match(q, /select exists\\(/)",
  "assert.ok(sql.includes('deleted_at is null'))",
  // A pending file that no longer compares SQL text must leave the list.
  { code: "expect(result.rows).toEqual([])", options: [{ pendingSqlText: true }], errors: [{ messageId: 'stale' }] },
])

run('no-local-canonical-json', [
  'function canonicalOrder(values) { return values }',
  'const stableId = id => id',
  { code: 'export function canonicalJson(value) { return JSON.stringify(value) }', filename: 'src/shared/canonicalJson.js' },
], [
  'function canonicalJson(value) { return JSON.stringify(value) }',
  'function canonicalJSON(value) { return JSON.stringify(value) }',
  'const stableStringify = value => JSON.stringify(value)',
  'function canonicalSerialize(value) { return value }',
  'const stable_json = value => value',
])

run('no-raw-transactions', [
  "await client.query('SELECT 1')",
  "await client.query('SELECT begin_at FROM runs')",
  "await transaction(pool, async client => client.query('UPDATE runs SET state = $1', [state]))",
], [
  "await client.query('BEGIN')",
  "await client.query('begin isolation level serializable')",
  'await client.query(`COMMIT`)',
  "await client.query('ROLLBACK')",
  "await query('START TRANSACTION')",
])

run('no-raw-database-pools', [
  "import pg from 'pg'; const pool = createPool(options, 'graphql-api')",
  "import pg from 'pg'; const client = createDedicatedClient(pool.options, 'graphql-run-owner')",
  "import { Client } from '@modelcontextprotocol/sdk/client/index.js'; const client = new Client({ name: 'x', version: '1' })",
  "import pg from 'pg'; const error = new pg.DatabaseError('failed', 0, 'error')",
], [
  "import pg from 'pg'; const pool = new pg.Pool({ max: 1 })",
  "import pg from 'pg'; const client = new pg.Client(pool.options)",
  "import * as postgres from 'pg'; const client = new postgres.Client()",
  "import { Pool } from 'pg'; const pool = new Pool()",
  "import { Client as PgClient } from 'pg'; const client = new PgClient()",
])

run('no-silent-catch', [
  'promise.catch(error => logger.warn({ error }, "cleanup failed"))',
  'promise.catch(() => { /* ignore: the process already exited */ })',
  'promise.catch(() => /* ignore: best-effort close */ undefined)',
  'try { run() } catch { // ignore: the file may not exist yet\n}',
  'try { run() } catch (error) { report(error) }',
], [
  'promise.catch(() => {})',
  'promise.catch(() => undefined)',
  'promise.catch(() => null)',
  'promise.catch(() => void 0)',
  'promise.catch(function () {})',
  'try { run() } catch {}',
  'try { run() } catch (error) { /* the file may not exist yet */ }',
])

run('no-error-rewrap-without-cause', [
  'try { run() } catch (error) { throw error }',
  "try { run() } catch (error) { throw new DomainError('X', 'm', 409, undefined, { cause: error }) }",
  "try { run() } catch (error) { throw new Error('m', { cause: error }) }",
  "try { run() } catch (error) { throw new NativeDeliveryError('turn', 'unknown', error) }",
  "try { run() } catch (error) { throw new AggregateError([error, other], 'both failed') }",
  "try { run() } catch (error) { throw new Outer('m', new AggregateError([error], 'x')) }",
  "try { run() } catch { throw new DomainError('INVALID_REQUEST', 'Invalid JSON.', 400) }",
  "try { run() } catch (error) { queue.push(() => { throw new Error('later') }) }",
  "promise.catch(error => { throw new Error('m', { cause: error }) })",
  "try { run() } catch (error) { throw new DomainError('X', 'm', 409 /* ignore: the cause holds a credential */) }",
], [
  "try { run() } catch (error) { throw new DomainError('X', error.message, 409) }",
  "try { run() } catch (error) { if (error.code === 'EEXIST') throw new Error('exists'); throw error }",
  "promise.catch(error => { throw new WorkerError('failed') })",
  "promise.catch(function (error) { throw new Error('failed') })",
])

run('no-legacy-execution-semantics', [
  'if (version.executionSemanticsVersion === 3) start()',
  'const value = { executionSemanticsVersion: 3 }',
], [
  'if (version.executionSemanticsVersion === 1) start()',
  'if (2 !== workflow.executionSemanticsVersion) start()',
  'if (executionSemanticsVersion < 2) start()',
  'switch (version.executionSemanticsVersion) { case 1: break; default: start() }',
])

run('test-timeout-limit', [
  "it('runs', async () => {}, 30_000)",
  "test('runs', { timeout: 20000 }, async () => {})",
  'beforeAll(async () => {}, 10_000)',
], [
  "it('runs', async () => {}, 60_000)",
  "test.concurrent('runs', async () => {}, 2 * 60_000)",
  "describe('suite', { timeout: 45000 }, () => {})",
  'beforeEach(async () => {}, 31_000)',
])

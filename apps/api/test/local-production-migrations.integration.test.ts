import { readUntil } from './helpers/observableCondition.js'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { join } from 'node:path'
import { expect, it } from 'vitest'
import { loadConfig } from '../src/config.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { createCheckpointStore } from '../src/composition/checkpoints.js'
import { PostgresAccessService } from '../src/modules/access/postgres.js'
import { PostgresLocalHumanAccess } from '../src/modules/access/localHuman.js'
import { currentDatabase, postgresEnabled } from './helpers/database.js'
import { createFixtureSchema, dropFixtureSchema } from './helpers/testResources.js'
import { compileApiFixture } from './helpers/compiledApiFixture.js'
import { withTransaction } from '../src/infrastructure/transaction.js'
import { deferred } from './helpers/deferred.js'

it.skipIf(!postgresEnabled)('migrates under DDL contention without changing the API request deadline', async () => {
  const fixture = await currentDatabase({ beforeMigration: 2026100401 })
  const url = new URL(process.env.TEST_DATABASE_URL!)
  url.searchParams.set('options', `-c search_path=${fixture.schema},public`)
  const checkpointSchema = `${fixture.schema}_checkpoints`
  await createFixtureSchema(fixture.pool, checkpointSchema)
  const environment = { ...process.env, DATABASE_URL: url.toString(), DATABASE_QUERY_TIMEOUT_MS: '100',
    LANGGRAPH_CHECKPOINT_SCHEMA: checkpointSchema }
  const options = loadConfig(environment).database
  const runtime = createDatabase(options)
  const checkpoints = createCheckpointStore(url.toString(), checkpointSchema)
  const holder = await fixture.pool.connect()
  const release = deferred()
  const entered = deferred<number>()
  let holding: Promise<void> | undefined
  let command: Promise<{ success: true } | { success: false; error: Error }> | undefined
  try {
    const compiledApi = await compileApiFixture(fixture.directory)
    holding = withTransaction({ client: holder }, async transaction => {
      await transaction.query('lock table application_migrations in access exclusive mode')
      entered.resolve((await transaction.query<{ pid: number }>('select pg_backend_pid() as pid')).rows[0]!.pid)
      await release.promise
    })
    const pid = await entered.promise
    command = promisify(execFile)(process.execPath, [join(compiledApi, 'cli/migrate.js')], {
      env: environment, timeout: 15_000, maxBuffer: 1024 * 1024,
    }).then(() => ({ success: true as const }), (error: Error) => ({ success: false as const, error }))
    const blocked = await readUntil(async () => (await fixture.pool.query<{ blocked: boolean }>(
      'select exists(select 1 from pg_stat_activity where $1 = any(pg_blocking_pids(pid))) as blocked', [pid],
    )).rows[0]!.blocked, value => value, { timeoutMs: 5000, description: 'the migration DDL lock' })
    expect(blocked).toBe(true)
    // eslint-disable-next-line no-restricted-syntax -- Holding the lock past the request deadline proves migration does not use that deadline.
    await new Promise(resolve => setTimeout(resolve, options.queryTimeoutMs + 1))
    release.resolve()
    await holding
    const result = await command
    expect(result.success, result.success ? undefined : result.error.message).toBe(true)
    const human = await new PostgresLocalHumanAccess(fixture.pool, new PostgresAccessService(fixture.pool)).current()
    expect(human.audience).toBe('operator')
    await checkpoints.ping()
    await expect(runtime.pool.query('select pg_sleep(0.5)')).rejects.toThrow(/timeout|canceling statement/i)
  } finally {
    release.resolve()
    if (holding) await holding
    holder.release()
    if (command) await command
    await checkpoints.close()
    await runtime.close()
    await dropFixtureSchema(fixture.pool, checkpointSchema)
    await fixture.close()
  }
}, 120_000)

import { randomUUID } from 'node:crypto'
import { mkdir } from 'node:fs/promises'
import { join } from 'node:path'
import { expect, it, vi } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/current'
import { loadConfig } from '../src/config.js'
import { createCheckpointStore } from '../src/composition/checkpoints.js'
import { createDatabase } from '../src/infrastructure/database.js'
import { OperatorRuntimeOwner } from '../src/infrastructure/operatorRuntimeOwner.js'
import { RuntimeShutdown } from '../src/infrastructure/runtimeShutdown.js'
import { buildProductionApp } from '../src/production.js'
import { currentDatabase, postgresEnabled } from './helpers/database.js'
import { deferred } from './helpers/deferred.js'
import { seedWorkflowFixture } from './helpers/workflowDatabase.js'

it.skipIf(!postgresEnabled)('settles a Run that finishes while graceful shutdown drains the workflow engine', async () => {
  const fixture = await currentDatabase()
  const url = new URL(process.env.TEST_DATABASE_URL!)
  url.searchParams.set('options', `-c search_path=${fixture.schema},public`)
  const runtime = join(fixture.directory, 'runtime')
  const workspaces = join(fixture.directory, 'workspaces')
  await Promise.all([runtime, workspaces].map(directory => mkdir(directory, { mode: 0o700 })))
  const config = loadConfig({ DATABASE_URL: url.toString(), HARNESS_WORKSPACE_ROOT: runtime,
    WORKSPACE_STORAGE_ROOT: workspaces, FILE_STORAGE_ROOT: join(fixture.directory, 'files'), PORT: '4100' })
  const database = createDatabase(config.database)
  const checkpointSchema = `${fixture.schema}_checkpoints`
  const checkpoints = createCheckpointStore(process.env.TEST_DATABASE_URL!, checkpointSchema, config.database)
  const releaseOwner = vi.spyOn(OperatorRuntimeOwner.prototype, 'close')
  // The onClose drain is where shutdown waits for the engine; the Run settles only once it has begun.
  const draining = deferred()
  const finish = RuntimeShutdown.prototype.finish
  vi.spyOn(RuntimeShutdown.prototype, 'finish').mockImplementation(function (this: RuntimeShutdown) {
    draining.resolve()
    return finish.call(this)
  })
  const production = buildProductionApp({ config, database, checkpoints, logger: false })
  try {
    await checkpoints.setup()
    await production.initialize()
    const seeded = await seedWorkflowFixture(fixture.pool, workspaces,
      makeCurrentWorkflowFixture(randomUUID().slice(0, 8), 'sequential'))
    seeded.run = { ...seeded.run, executionState: 'completed', outcome: 'succeeded', finishedAt: seeded.createdAt }
    await fixture.pool.query('update runs set execution_state=$2,record=$3::jsonb where id=$1',
      [seeded.run.id, 'completed', JSON.stringify(seeded.run)])
    let settled = false
    vi.spyOn(production.engine, 'shutdown').mockImplementation(async () => {
      await draining.promise
      await production.engine.finishRunLifecycle(seeded.run.id)
      settled = true
    })
    await production.shutdown()
    expect(settled).toBe(true)
    expect(releaseOwner).toHaveBeenCalledOnce()
  } finally {
    draining.resolve()
    try {
      await production.shutdown().catch((error: unknown) => {
        // ignore: the assertion above reports the shutdown failure; cleanup must still run.
        void error
      })
    } finally {
      await checkpoints.close()
      await database.close()
      await fixture.pool.query(`drop schema if exists ${checkpointSchema} cascade`)
      await fixture.close()
      vi.restoreAllMocks()
    }
  }
}, 30_000)

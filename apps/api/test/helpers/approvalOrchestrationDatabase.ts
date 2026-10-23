import { afterAll, beforeAll } from 'vitest'
import { migratedDatabase } from './migratedDatabase.js'

/** Register a migrated database shared by cases with independent workflow identities. */
export function approvalOrchestrationDatabase() {
  let database: Awaited<ReturnType<typeof migratedDatabase>>

  beforeAll(async () => {
    database = await migratedDatabase()
  }, 60000)
  afterAll(async () => {
    await database?.close()
  }, 60000)

  return () => database
}

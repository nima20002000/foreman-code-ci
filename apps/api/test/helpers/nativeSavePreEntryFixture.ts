import { randomUUID } from 'node:crypto'
import { afterAll, beforeAll } from 'vitest'
import { makeCurrentWorkflowFixture } from '@foreman-code/contracts/current'
import { migratedDatabase } from './migratedDatabase.js'
import { currentOperatorIntegration } from './currentOperatorIntegration.js'

export function nativeSavePreEntryFixtures() {
  let database: Awaited<ReturnType<typeof migratedDatabase>> | undefined

  beforeAll(async () => {
    database = await migratedDatabase()
  }, 60000)

  afterAll(async () => {
    await database?.close()
  }, 60000)

  return async (form: 'single' | 'repeat') => {
    if (!database) throw new Error('Pre-entry fixture database is not initialized')
    return currentOperatorIntegration({
      database,
      fixture: makeCurrentWorkflowFixture(randomUUID(), form),
      approvalNodeIds: [],
    })
  }
}

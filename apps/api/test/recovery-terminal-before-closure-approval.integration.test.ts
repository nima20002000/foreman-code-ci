import { describe, it } from 'vitest'
import { postgresEnabled } from './helpers/database.js'
import { recoverTerminalBeforeClosure, useCrashCutDatabase } from './helpers/restartCrashCuts.js'

describe.skipIf(!postgresEnabled)('terminal recovery before native closure', () => {
  const database = useCrashCutDatabase()
  describe.each(['sequential', 'repeat'] as const)('%s', (form) => {
    it('recovers a durable terminal before its closure receipt: approval', async () => {
      await recoverTerminalBeforeClosure(database(), form, 'approval')
    }, 60_000)
  })
})

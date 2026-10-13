import { describe, it } from 'vitest'
import { postgresEnabled } from './helpers/wave25Agent3.js'
import { recoverTerminalBeforeClosure, useCrashCutDatabase } from './helpers/restartCrashCuts.js'

/** PostgreSQL, source captures, checkpoint, approval ACK and acceptance services
 * are real. Only provider transport and filesystem qualification are synthetic. */
describe.skipIf(!postgresEnabled)('repeat terminal recovery before native closure', () => {
  const database = useCrashCutDatabase()
  it.each(['success', 'approval', 'retry', 'retry-exhausted', 'stop'] as const)(
    'recovers a durable terminal before its closure receipt: %s', async (kind) => {
      await recoverTerminalBeforeClosure(database(), 'repeat', kind)
    }, 60_000)
})

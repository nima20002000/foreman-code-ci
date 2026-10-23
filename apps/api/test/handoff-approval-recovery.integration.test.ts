import { afterEach, describe, it, vi } from 'vitest'
import { runHandoffApproval } from './helpers/handoffApproval.js'
import { postgresEnabled } from './helpers/database.js'

afterEach(() => vi.restoreAllMocks())

describe.skipIf(!postgresEnabled)('handoff Worker approval through the designated Orchestrator', () => {
  it.each([false, true])('resumes each business activation with persisted reviewer ownership (restart=%s)', async restart => {
    await runHandoffApproval({ restart })
  }, 120000)
})

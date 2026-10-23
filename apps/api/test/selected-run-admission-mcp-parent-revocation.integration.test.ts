import { describe, it } from 'vitest'
import { assertRevocationRejected } from './selected-run-admission.helpers.js'
import { postgresEnabled } from './helpers/database.js'

const cases = [{ transport: 'mcp' as const, revocation: 'parent' as const, boundary: 'first-advisory' as const }]

describe.skipIf(!postgresEnabled)('selected Run authorization during message admission', () => {
  it.each(cases)(
    '$transport rejects $revocation revocation committed during $boundary contention',
    assertRevocationRejected,
    90000,
  )
})

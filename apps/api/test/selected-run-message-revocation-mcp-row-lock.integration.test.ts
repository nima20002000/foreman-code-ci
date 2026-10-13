import { describe, it } from 'vitest'
import { assertRevocationRejected } from './helpers/selectedRunMessageRevocation.js'
import { postgresEnabled } from './helpers/wave25Agent3.js'

describe.skipIf(!postgresEnabled)('selected Run MCP message authorization during transcript row contention', () => {
  it.each(['principal', 'parent'] as const)('rejects committed %s revocation', async revocation => {
    await assertRevocationRejected({ transport: 'mcp', boundary: 'existing-row', revocation })
  }, 90000)
})

import { describe, expect, it } from 'vitest'
import { HarnessMcpChangeSchema, HarnessMcpEndpointSchema } from './harnessSettings.js'

describe('MCP endpoint validation', () => {
  it('reports an empty or malformed URL as a validation issue instead of throwing', () => {
    expect(HarnessMcpEndpointSchema.safeParse('').success).toBe(false)
    expect(HarnessMcpEndpointSchema.safeParse('not a url').success).toBe(false)
    expect(HarnessMcpChangeSchema.safeParse({ kind: 'add', name: '', connection: { transport: 'remote', url: '' } }).success).toBe(false)
  })
  it('still rejects credentials and accepts a plain HTTPS endpoint', () => {
    expect(HarnessMcpEndpointSchema.safeParse('https://user:secret@example.com/mcp').success).toBe(false)
    expect(HarnessMcpEndpointSchema.safeParse('https://example.com/mcp').success).toBe(true)
  })
})

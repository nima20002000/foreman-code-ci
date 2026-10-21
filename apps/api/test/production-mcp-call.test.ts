import type { Client } from '@modelcontextprotocol/client'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { callProductionMcpTool } from './helpers/productionMcpCall.js'

const request = { name: 'workspace_root_location_set', arguments: {
  workspaceId: 'fixture-workspace', commandId: 'f7e99b91-5446-430f-bd7d-755b377f55d9',
} }
const success = { content: [], structuredContent: { saved: true } }

function failure(details: Record<string, unknown> = { retryable: true }, structured = false) {
  const body = { error: { code: 'DATABASE_BUSY', message: 'Retry with the same commandId.', details } }
  return { isError: true, content: [{ type: 'text' as const, text: JSON.stringify(body) }],
    ...(structured ? { structuredContent: body } : {}) }
}

describe('production fixture MCP calls', () => {
  beforeEach(() => vi.useFakeTimers())
  afterEach(() => vi.useRealTimers())

  it.each([false, true])('retries retryable errors with the original request (structured: %s)', async structured => {
    const callTool = vi.fn<Client['callTool']>()
      .mockResolvedValueOnce(failure({ retryable: true, newCommandRequired: false }, structured))
      .mockResolvedValueOnce(failure({ retryable: true }, structured))
      .mockResolvedValue(success)
    const options = { timeout: 180000 }
    const result = callProductionMcpTool({ callTool }, request, options)
    await vi.runAllTimersAsync()
    expect(await result).toBe(success)
    expect(callTool).toHaveBeenCalledTimes(3)
    for (const [sent, sentOptions] of callTool.mock.calls) {
      expect(sent).toBe(request)
      expect(sent.arguments).toEqual(request.arguments)
      expect(sentOptions).toBe(options)
    }
  })

  it('backs off and returns the final error after five attempts', async () => {
    const last = failure({ retryable: true, attempt: 'last' })
    const callTool = vi.fn<Client['callTool']>()
      .mockResolvedValueOnce(failure()).mockResolvedValueOnce(failure())
      .mockResolvedValueOnce(failure()).mockResolvedValueOnce(failure()).mockResolvedValue(last)
    const started = Date.now()
    const result = callProductionMcpTool({ callTool }, request)
    await vi.advanceTimersByTimeAsync(249)
    expect(callTool).toHaveBeenCalledTimes(1)
    await vi.advanceTimersByTimeAsync(1)
    expect(callTool).toHaveBeenCalledTimes(2)
    await vi.runAllTimersAsync()
    expect(await result).toBe(last)
    expect(callTool).toHaveBeenCalledTimes(5)
    expect(Date.now() - started).toBe(3750)
    expect(vi.getTimerCount()).toBe(0)
  })

  it.each([
    { retryable: false }, {}, { retryable: 'true' }, { retryable: true, newCommandRequired: true },
  ])('returns errors that cannot be retried unchanged: %j', async details => {
    const error = failure(details)
    const callTool = vi.fn<Client['callTool']>().mockResolvedValue(error)
    expect(await callProductionMcpTool({ callTool }, request)).toBe(error)
    expect(callTool).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('returns success without retrying', async () => {
    const callTool = vi.fn<Client['callTool']>().mockResolvedValue(success)
    expect(await callProductionMcpTool({ callTool }, request)).toBe(success)
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it('propagates transport exceptions without retrying', async () => {
    const error = new Error('Connection closed')
    const callTool = vi.fn<Client['callTool']>().mockRejectedValue(error)
    await expect(callProductionMcpTool({ callTool }, request)).rejects.toBe(error)
    expect(callTool).toHaveBeenCalledTimes(1)
  })
})

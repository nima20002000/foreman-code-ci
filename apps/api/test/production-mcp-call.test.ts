import type { Client } from '@modelcontextprotocol/client'
import { z } from 'zod'
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

function clientWithTools(callTool: Client['callTool'], tools: Awaited<ReturnType<Client['listTools']>>['tools'] = [{
  name: request.name, inputSchema: { type: 'object' as const, properties: { commandId: { type: 'string' } } },
  annotations: { readOnlyHint: false },
}]) {
  return { callTool, listTools: vi.fn<Client['listTools']>().mockResolvedValue({ tools }) }
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
    const result = callProductionMcpTool(clientWithTools(callTool), request, options)
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
    const result = callProductionMcpTool(clientWithTools(callTool), request)
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
    expect(await callProductionMcpTool(clientWithTools(callTool), request)).toBe(error)
    expect(callTool).toHaveBeenCalledTimes(1)
    expect(vi.getTimerCount()).toBe(0)
  })

  it('assigns one commandId before the first attempt when omitted', async () => {
    const input = { name: request.name, arguments: { workspaceId: 'fixture-workspace' } }
    const sentIds: unknown[] = []
    const callTool = vi.fn<Client['callTool']>().mockImplementation(async sent => {
      sentIds.push(sent.arguments?.commandId)
      return sentIds.length < 3 ? failure() : success
    })
    const result = callProductionMcpTool(clientWithTools(callTool), input)
    await vi.runAllTimersAsync()
    expect(await result).toBe(success)
    expect(callTool).toHaveBeenCalledTimes(3)
    expect(z.uuid().safeParse(sentIds[0]).success).toBe(true)
    expect(sentIds).toEqual([sentIds[0], sentIds[0], sentIds[0]])
    expect(input.arguments).toEqual({ workspaceId: 'fixture-workspace' })
    expect(callTool.mock.calls[0]![0]).toBe(callTool.mock.calls[2]![0])
  })

  it('assigns commandId even when the first attempt succeeds', async () => {
    const callTool = vi.fn<Client['callTool']>().mockResolvedValue(success)
    await callProductionMcpTool(clientWithTools(callTool), { name: request.name })
    expect(z.uuid().safeParse(callTool.mock.calls[0]![0].arguments?.commandId).success).toBe(true)
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it.each([undefined, request.arguments.commandId])(
    'does not retry a write whose schema has no commandId (supplied: %s)', async commandId => {
      const error = failure()
      const callTool = vi.fn<Client['callTool']>().mockResolvedValue(error)
      const client = clientWithTools(callTool, [{
        name: 'fixture_write', inputSchema: { type: 'object', properties: {} },
        annotations: { readOnlyHint: false },
      }])
      const input = { name: 'fixture_write', arguments: { ...(commandId ? { commandId } : {}) } }
      const result = callProductionMcpTool(client, input)
      await vi.runAllTimersAsync()
      expect(await result).toBe(error)
      expect(callTool).toHaveBeenCalledExactlyOnceWith(input, undefined)
      expect(vi.getTimerCount()).toBe(0)
    })

  it('does not retry an unlisted tool', async () => {
    const error = failure()
    const callTool = vi.fn<Client['callTool']>().mockResolvedValue(error)
    const result = callProductionMcpTool(clientWithTools(callTool, []), { name: 'unlisted_write' })
    await vi.runAllTimersAsync()
    expect(await result).toBe(error)
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it('retries a declared read without adding commandId', async () => {
    const callTool = vi.fn<Client['callTool']>().mockResolvedValueOnce(failure()).mockResolvedValue(success)
    const client = clientWithTools(callTool, [{
      name: 'fixture_read', inputSchema: { type: 'object', properties: {} },
      annotations: { readOnlyHint: true },
    }])
    const input = { name: 'fixture_read', arguments: { workspaceId: 'fixture-workspace' } }
    const result = callProductionMcpTool(client, input)
    await vi.runAllTimersAsync()
    expect(await result).toBe(success)
    expect(callTool).toHaveBeenCalledTimes(2)
    expect(callTool.mock.calls.map(([sent]) => sent)).toEqual([input, input])
  })

  it('returns success without retrying', async () => {
    const callTool = vi.fn<Client['callTool']>().mockResolvedValue(success)
    expect(await callProductionMcpTool(clientWithTools(callTool), request)).toBe(success)
    expect(callTool).toHaveBeenCalledTimes(1)
  })

  it('propagates transport exceptions without retrying', async () => {
    const error = new Error('Connection closed')
    const callTool = vi.fn<Client['callTool']>().mockRejectedValue(error)
    await expect(callProductionMcpTool(clientWithTools(callTool), request)).rejects.toBe(error)
    expect(callTool).toHaveBeenCalledTimes(1)
  })
})

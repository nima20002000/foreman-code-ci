import type { Client } from '@modelcontextprotocol/client'
import { ApiErrorResponseSchema } from '@foreman-code/contracts'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'

export async function callProductionMcpTool(client: Pick<Client, 'callTool'>,
  request: Parameters<Client['callTool']>[0], options?: Parameters<Client['callTool']>[1]) {
  for (let attempt = 0; ; attempt++) {
    const result = await client.callTool(request, options)
    if (!result.isError || attempt >= 4) return result
    const failure = ApiErrorResponseSchema.safeParse(decodeMcpToolResult(result))
    const details = failure.success ? failure.data.error.details : undefined
    if (details?.retryable !== true || details.newCommandRequired === true) return result
    // Reuse the whole request so an admitted command is replayed with its original commandId.
    await new Promise<void>(resolve => setTimeout(resolve, 250 * 2 ** attempt))
  }
}

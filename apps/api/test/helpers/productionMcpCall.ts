import type { Client } from '@modelcontextprotocol/client'

export async function callProductionMcpTool(client: Pick<Client, 'callTool'>,
  request: Parameters<Client['callTool']>[0], options?: Parameters<Client['callTool']>[1]) {
  return client.callTool(request, options)
}

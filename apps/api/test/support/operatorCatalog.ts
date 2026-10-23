import type { Client } from '@modelcontextprotocol/client'
import type { Tool } from '@modelcontextprotocol/server'
import { decodeMcpToolResult } from '@foreman-code/contracts/operator-mcp'
import { TOOL_DETAIL_META } from '../../src/mcp/shared/toolDetail.js'

/**
 * Operator tools/list shows only a small core plus the discovery tools. The caller's complete
 * grant-filtered catalog is reached through tools_find (names) and tool_schema (one tool's
 * description, detail, input schema and annotations). These helpers read that full catalog so tests can
 * assert which tools a caller can use without depending on what tools/list happens to show.
 */
type Caller = Pick<Client, 'callTool'>

/** Every tool name the caller can use: the listed core plus everything tools_find returns. */
export async function operatorCatalogNames(client: Caller): Promise<string[]> {
  const found = decodeMcpToolResult(await client.callTool({ name: 'tools_find', arguments: {} })) as { tools: { name: string }[] }
  return found.tools.map(tool => tool.name).sort()
}

/** The caller's complete catalog as tools, each read through tool_schema, with its detail in _meta. */
export async function operatorCatalog(client: Caller): Promise<Tool[]> {
  const tools: Tool[] = []
  for (const name of await operatorCatalogNames(client)) {
    const schema = decodeMcpToolResult(await client.callTool({ name: 'tool_schema', arguments: { name } })) as
      { name: string; description: string; detail?: string; inputSchema: Tool['inputSchema']; annotations?: Tool['annotations'] }
    tools.push({ name: schema.name, description: schema.description, inputSchema: schema.inputSchema,
      ...(schema.annotations ? { annotations: schema.annotations } : {}),
      ...(schema.detail ? { _meta: { [TOOL_DETAIL_META]: schema.detail } } : {}) })
  }
  return tools
}

import { COLLABORATION_AGENT_TOOLS, type GraphqlAgentTool } from '@foreman-code/contracts'
import type { OperatorRequestContext } from '../../mcp/operator/types.js'
import type { OperatorToolDefinition } from '../../mcp/operator/definition.js'
import { createBrowserProfileTools } from '../../mcp/operator/tools/browserProfiles.js'
import { createBrowserSessionTools } from '../../mcp/operator/tools/browserSessions.js'

export const browserAgentTools = Object.keys(COLLABORATION_AGENT_TOOLS)
  .filter(name => name.startsWith('browser_')) as GraphqlAgentTool[]

export function browserOperatorTools(context: OperatorRequestContext): OperatorToolDefinition[] {
  const browser = context.services.browser
  if (!browser) return []
  return [...createBrowserProfileTools(browser.handlers, browser.codecs),
    ...createBrowserSessionTools(browser.handlers, browser.codecs)]
}

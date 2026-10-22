import { COLLABORATION_AGENT_TOOLS, BrowserTargetSelectionSchema, BrowserTargetResultSchema, type GraphqlAgentTool,
  type GraphqlToolOverride } from '@foreman-code/contracts'
import type { OperatorRequestContext } from '../../mcp/operator/types.js'
import type { OperatorToolDefinition } from '../../mcp/operator/definition.js'
import { createBrowserProfileTools } from '../../mcp/operator/tools/browserProfiles.js'
import { createBrowserSessionTools } from '../../mcp/operator/tools/browserSessions.js'

export const browserAgentTools = Object.keys(COLLABORATION_AGENT_TOOLS)
  .filter(name => name.startsWith('browser_')) as GraphqlAgentTool[]

/** A chat's browser switch turns its browser tools on, as saving the node with the browser on does,
 * unless the node turns a tool off. */
export function chatToolOverride(override: GraphqlToolOverride | undefined, browser?: { enabled: boolean }) {
  if (!browser?.enabled) return override
  const removed = new Set(override?.remove ?? [])
  return { add: [...new Set([...override?.add ?? [], ...browserAgentTools.filter(tool => !removed.has(tool))])],
    remove: [...removed] }
}

export function browserOperatorTools(context: OperatorRequestContext): OperatorToolDefinition[] {
  const browser = context.services.browser
  if (!browser) return []
  return [...createBrowserProfileTools(browser.handlers, browser.codecs),
    ...createBrowserSessionTools(browser.handlers, browser.codecs), {
      name: 'browser_target_read', description: 'Resolve the selected saved Agent, execution or active coordinator browser subject without creating a session. Ambiguous Runs remain an explicit selection.',
      requires: [['workflows:read', 'workflow']], inputSchema: BrowserTargetSelectionSchema, outputSchema: BrowserTargetResultSchema,
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
      run: (context, input) => browser.target(context.principal, input),
    }]
}

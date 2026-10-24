import { COLLABORATION_AGENT_TOOLS, BrowserTargetSelectionSchema, BrowserTargetResultSchema, type GraphqlAgentTool,
  type RecordedGraphqlToolOverride } from '@foreman-code/contracts'
import { z } from 'zod'
import type { OperatorRequestContext } from '../../mcp/operator/types.js'
import type { OperatorToolDefinition } from '../../mcp/operator/definition.js'
import { createBrowserProfileTools } from '../../mcp/operator/tools/browserProfiles.js'
import { createBrowserSessionTools } from '../../mcp/operator/tools/browserSessions.js'

export const browserAgentTools = Object.keys(COLLABORATION_AGENT_TOOLS)
  .filter(name => name.startsWith('browser_')) as GraphqlAgentTool[]

/** A chat's browser switch turns its browser tools on, as saving the node with the browser on does,
 * unless the node turns a tool off. */
export function chatToolOverride(override: RecordedGraphqlToolOverride | undefined, browser?: { enabled: boolean }) {
  if (!browser?.enabled) return override
  const removed = new Set(override?.remove ?? [])
  return { add: [...new Set([...override?.add ?? [], ...browserAgentTools.filter(tool => !removed.has(tool))])],
    remove: [...removed] }
}

/** A chat's browser tools always act on the chat's own session, so callers never type its ID; the actor is filled
 * in from the session's current control facts. */
export function chatBrowserInputSchema<S>(input: S): S {
  const schema = input as unknown
  if (schema instanceof z.ZodObject) {
    const shape = schema.shape as Record<string, z.ZodType>
    if (!('sessionId' in shape)) return input
    const rest = schema.omit({ sessionId: true } as never)
    return ('actor' in shape ? rest.extend({ actor: shape.actor!.optional() }) : rest) as S
  }
  if (schema instanceof z.ZodDiscriminatedUnion) {
    return z.discriminatedUnion(schema.def.discriminator, schema.options.map(chatBrowserInputSchema) as never) as S
  }
  if (schema instanceof z.ZodUnion) return z.union(schema.options.map(chatBrowserInputSchema) as never) as S
  return input
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

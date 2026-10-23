import { z } from 'zod'
import { SavedNodePlacementSchema } from '@foreman-code/contracts/node-placement'
import { AssignedSkillSchema, GraphqlToolDefaultsSchema, GraphqlToolOverrideSchema, HarnessConfigurationSchema, withBrowserToolDefaults } from '@foreman-code/contracts'
import { sameWorkflowValue, type WorkflowDefinitionV3 } from '@foreman-code/contracts/wave25'

// Raw form state is browser-only, including unfinished JSON. Publication still
// uses the shared Agent and harness validation through Save agent settings.
const HarnessFormSchema = z.object({ configuration: HarnessConfigurationSchema,
  shellEnvironmentText: z.string(), mcpText: z.string() }).strict()
export const AgentFormSchema = z.object({ base: z.string().refine((value) => { try { JSON.parse(value); return true } catch { return false } }), name: z.string(), prompt: z.string(),
  /** Persistent Agent instructions and ordered skill references; absent in forms saved before Skills v1. */
  placement: SavedNodePlacementSchema.optional(),
  branchPrefix: z.string().optional(),
  instructions: z.string().optional(), skills: z.array(AssignedSkillSchema).optional(),
  editor: HarnessFormSchema.extend({ drafts: z.object({ codex: HarnessFormSchema.optional(),
    claude: HarnessFormSchema.optional() }).strict().optional() }),
  graphqlTools: z.object({ defaults: GraphqlToolDefaultsSchema.optional(), override: GraphqlToolOverrideSchema.optional() }).strict().optional(),
}).strict()
export type AgentForm = z.infer<typeof AgentFormSchema>

/** The browser switch writes the node's tools straight to the draft. An open, unapplied settings form follows that
 * change (same browser tool defaults, new base) instead of being dropped and reset to the saved Agent. */
export function rebaseAgentFormTools<T extends { graph: WorkflowDefinitionV3; agentForms?: Record<string, AgentForm> | undefined }>(
  current: T, nodeId: string): T {
  const form = current.agentForms?.[nodeId]
  const node = current.graph.nodes.find(item => item.id === nodeId)
  if (!form || !node || node.kind === 'job') return current
  const { nodeGraphqlTools, ...base } = JSON.parse(form.base) as Record<string, unknown>
  if (sameWorkflowValue(nodeGraphqlTools, node.graphqlTools)) return current
  const override = withBrowserToolDefaults({ browser: node.browser, graphqlTools: form.graphqlTools?.override }).graphqlTools
  return { ...current, agentForms: { ...current.agentForms, [nodeId]: { ...form,
    base: JSON.stringify({ ...base, ...(node.graphqlTools ? { nodeGraphqlTools: node.graphqlTools } : {}) }),
    graphqlTools: { ...form.graphqlTools, ...(override ? { override } : {}) } } } }
}

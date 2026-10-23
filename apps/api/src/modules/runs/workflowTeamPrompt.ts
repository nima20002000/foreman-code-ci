import { AGENT_PRODUCT_ROLE_LABELS, type AgentConfigurationVersion, type AgentProductRole } from '@foreman-code/contracts'
import type { WorkflowDefinitionCurrent, WorkflowVersionCurrent } from '@foreman-code/contracts/current'

/** The pinned facts of one connected Agent that its neighbours are told about. */
export interface WorkflowTeamMember { productRole?: AgentProductRole | undefined; instructions?: string | undefined }
/** Keyed by workflow node ID: the Agent itself and every Agent connected to it by an execution edge. */
export type WorkflowTeam = Readonly<Record<string, WorkflowTeamMember>>

/** An Orchestrator or Master receives the result of the work it hands out and checks it. */
export const isCoordinatorRole = (role: string | null | undefined) => role === 'orchestrator' || role === 'master'

function connectedNodeIds(definition: WorkflowDefinitionCurrent, nodeId: string): string[] {
  const ids = definition.edges.flatMap(edge => edge.kind !== 'execution' ? []
    : edge.source === nodeId ? [edge.target] : edge.target === nodeId ? [edge.source] : [])
  return [...new Set(ids)].filter(id => id !== nodeId && definition.nodes.some(node => node.id === id && node.kind !== 'job'))
}

/** Reads the exact pinned configurations of the Agent and its connected Agents. */
export async function readWorkflowTeam(version: WorkflowVersionCurrent, nodeId: string,
  read: (configurationVersionId: string) => Promise<Pick<AgentConfigurationVersion, 'productRole' | 'prompt'> | undefined>,
): Promise<WorkflowTeam> {
  const team: Record<string, WorkflowTeamMember> = {}
  for (const id of [nodeId, ...connectedNodeIds(version.definition, nodeId)]) {
    const node = version.definition.nodes.find(item => item.id === id)
    const configurationId = node && node.kind !== 'job' ? version.agentConfigurationVersionIds[node.agentId] : undefined
    const configuration = configurationId ? await read(configurationId) : undefined
    if (configuration) team[id] = { productRole: configuration.productRole, instructions: configuration.prompt.system }
  }
  return team
}

const short = (text: string, limit = 240) => text.length > limit ? `${text.slice(0, limit - 1)}…` : text

/** Request-only: who this Agent works with and how work moves between them. Compact by design. */
export function workflowTeamPrompt(definition: WorkflowDefinitionCurrent, nodeId: string, team: WorkflowTeam,
  callerNodeId?: string): string | undefined {
  const node = definition.nodes.find(item => item.id === nodeId)
  const connected = connectedNodeIds(definition, nodeId)
  if (!node || node.kind === 'job' || !connected.length) return undefined
  const nameOf = (id: string) => {
    const item = definition.nodes.find(candidate => candidate.id === id)
    return JSON.stringify(item && item.kind !== 'job' ? item.name ?? item.label ?? id : id)
  }
  const members = connected.map(id => {
    const item = definition.nodes.find(candidate => candidate.id === id)!
    if (item.kind === 'job') return ''
    const role = team[id]?.productRole
    const traits = [role ? AGENT_PRODUCT_ROLE_LABELS[role] : 'Agent', ...(item.browser?.enabled ? ['has a web browser'] : [])]
    const instructions = [item.initialPrompt, team[id]?.instructions].filter(Boolean).join(' ').trim()
    return `- ${nameOf(id)} (${traits.join('; ')})${instructions ? `. Their instructions: ${JSON.stringify(short(instructions))}` : ''}`
  })
  const hierarchy = definition.hierarchy !== undefined
  const downstream = definition.edges.filter(edge => edge.kind === 'execution' && edge.source === nodeId).map(edge => nameOf(edge.target))
  const coordinator = isCoordinatorRole(team[nodeId]?.productRole)
  const caller = callerNodeId && callerNodeId !== nodeId && isCoordinatorRole(team[callerNodeId]?.productRole) ? nameOf(callerNodeId) : undefined
  const handOff = hierarchy || node.choice || !downstream.length ? [] : [
    `To give ${downstream.join(', ')} work, finish with {"kind":"finish"}, remainingFindings [] and their complete task in data.latestDeliverable; they see only what you send.`,
    ...(coordinator ? ['Their result comes back to you as a work request. Check it, then return {"kind":"return","outcome":"accepted"} when it is good, or "needs_changes" with what to fix in latestDeliverable; they continue and report back again.'] : []),
  ]
  const report = hierarchy || node.choice || downstream.length || !caller ? [] : [
    `${caller} gave you this work and checks your result. When done, finish with {"kind":"finish"} (not return): your latestDeliverable and remainingFindings go back to ${caller}.`,
  ]
  return ['Agents connected to you in this workflow:', ...members, ...handOff, ...report,
    'Agents reach each other only through these results; do not ask the owner to pass messages.'].join('\n')
}

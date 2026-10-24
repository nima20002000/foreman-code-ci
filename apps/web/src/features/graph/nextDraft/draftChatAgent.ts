import { INSTALLATION_NAMES } from '@foreman-code/contracts/installation-names'
import { SupportedHarnessConfigurationSchema } from '@foreman-code/contracts'
import { updateManagedAgent } from '../../../shared/api/client'
import { useGraphDraftStore } from '../store'
import { configureAgentOperations } from '../../board-core'
import { nextDraftApi } from './transport'

export function draftNodeAgent(draftKey: string, nodeId: string) {
  const node = useGraphDraftStore.getState().nextDrafts[draftKey]?.graph.nodes.find(item => item.id === nodeId)
  return node && node.kind !== 'job' ? node : undefined
}

/** Chat needs only the node's Agent saved, not the workflow graph: a draft-only Agent is saved alone through the
 * shared Agent service and joins the draft's saved Agents, so the next workflow Save updates it instead of adding it. */
export async function saveChatAgent(draftKey: string, nodeId: string): Promise<string | undefined> {
  const node = draftNodeAgent(draftKey, nodeId)
  const current = useGraphDraftStore.getState().nextDrafts[draftKey]
  if (!node || !current) return undefined
  const source = current.context.agents.find(item => item.agent.id === node.agentId)
  if (source) return saveChatAgentEdits(draftKey, node.agentId)
  const agent = current.agentEdits?.[node.agentId]
  if (!agent) return undefined
  const saved = await nextDraftApi.createAgent(current.context.draft.workspaceId, agent)
  useGraphDraftStore.getState().updateNextDraft(draftKey, state => {
    const agentEdits = { ...state.agentEdits }
    // The saved Agent is now the comparison base; a later local edit of it is staged as an update.
    const edited = agentEdits[saved.agent.id]
    if (edited === agent) delete agentEdits[saved.agent.id]
    else if (edited) agentEdits[saved.agent.id] = { ...edited, configurationVersionId: saved.agent.configurationVersionId }
    return { ...state, agentEdits, context: { ...state.context,
      agents: [...state.context.agents.filter(item => item.agent.id !== saved.agent.id), saved] } }
  })
  return node.agentId
}

/** A saved Agent's unsaved settings (e.g. browser turned on) reach its chat at once: only that Agent is updated, and the
 * chat's next turn picks up the new configuration. The workflow graph is not saved. */
async function saveChatAgentEdits(draftKey: string, agentId: string): Promise<string> {
  const current = useGraphDraftStore.getState().nextDrafts[draftKey]
  const source = current?.context.agents.find(item => item.agent.id === agentId)
  const edit = current?.agentEdits?.[agentId]
  const versionId = source?.agent.configurationVersionId
  if (!current || !source || !edit || !versionId || !configureAgentOperations(current.context, current.graph, { [agentId]: edit }).length) return agentId
  const harness = SupportedHarnessConfigurationSchema.parse(edit.harnessConfiguration)
  const result = await updateManagedAgent({ workspaceId: current.context.draft.workspaceId, agentId,
    commandId: `chat-agent:${agentId}:${crypto.randomUUID()}`, expectedRevision: source.metadataRevision,
    expectedConfigurationVersionId: versionId, name: edit.name, configuration: harness,
    ...(edit.productRole ? { productRole: edit.productRole } : {}), description: edit.description ?? null, role: edit.role ?? null,
    ...(edit.harnessProfileSelection ? { harnessProfileSelection: edit.harnessProfileSelection } : {}),
    prompt: edit.prompt ?? {}, assignedSkills: edit.assignedSkills ?? [],
    ...(edit[INSTALLATION_NAMES.fields.agentTools] ? { [INSTALLATION_NAMES.fields.agentTools]: edit[INSTALLATION_NAMES.fields.agentTools] } : {}), ...(edit.nativeTools ? { nativeTools: edit.nativeTools } : {}) })
  const saved = { agent: result.value.agent, metadataRevision: result.value.metadataRevision }
  useGraphDraftStore.getState().updateNextDraft(draftKey, state => {
    const agentEdits = { ...state.agentEdits }
    const edited = agentEdits[agentId]
    if (edited === edit) delete agentEdits[agentId]
    else if (edited) agentEdits[agentId] = { ...edited, configurationVersionId: saved.agent.configurationVersionId }
    return { ...state, agentEdits, context: { ...state.context,
      agents: [...state.context.agents.filter(item => item.agent.id !== agentId), saved] } }
  })
  return agentId
}

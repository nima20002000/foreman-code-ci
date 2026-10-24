import { INSTALLATION_NAMES } from '@foreman-code/contracts/installation-names'
import { agentTemplateForRole, newAgentForemanTools, type Agent, type RecordedAgentDefaults,
  type WorkflowAgentProductRole } from '@foreman-code/contracts'
import { ActionMenu } from '../../shared/ui/nocturne'
import { useAgentDefaultsQuery, useManagedHarnessCatalogQuery } from '../../shared/api/query'
import type { getManagedHarnessCatalog } from '../../shared/api/client'

type HarnessCatalog = Awaited<ReturnType<typeof getManagedHarnessCatalog>>
import { defaultAgentForHarness } from '../agents/agentSettings'
import { useGraphDraftStore } from '../graph/store'
import { editorAgents, type NextDraftEdit } from '../board-core'
import { currentBoardView, pinBoardLayout, placeNewNode } from '../graph/nextDraft/placement'
import { hierarchyNodes, stageHierarchyAgent } from './authoring'

const roles = [['master', 'Master'], ['orchestrator', 'Orchestrator'], ['coder', 'Worker']] as const

/** A new Agent from the role's profile in Settings, numbered after the same-role Agents on this Board. */
function newBoardAgent(edit: NextDraftEdit, defaults: RecordedAgentDefaults, role: WorkflowAgentProductRole, label: string,
  catalog: HarnessCatalog = []): Agent {
  const profile = agentTemplateForRole(defaults, role)
  // A profile on a harness that is not signed in here starts on a signed-in harness's defaults instead.
  const signedIn = (harness: string) => catalog.some(entry => entry.harness === harness && entry.capability?.authenticated)
  const fallback = catalog.find(entry => entry.capability?.authenticated)
  const switched = !!catalog.length && !signedIn(profile.harness.harness) && !!fallback
  // Harness-specific profile parts (computer profile, native tools) stay with the profile's own harness.
  const template = switched ? { ...profile, harness: structuredClone(fallback!.defaults) } : profile
  if (template.harness.harness !== 'codex' && template.harness.harness !== 'claude') {
    throw new Error(`The ${label} profile in Settings needs a Codex or Claude harness.`)
  }
  const agents = new Map(editorAgents(edit).map(agent => [agent.id, agent]))
  const same = edit.graph.nodes.filter(node => node.kind !== 'job' && agents.get(node.agentId)?.productRole === role).length
  return { ...defaultAgentForHarness(template.harness.harness, `agent-${crypto.randomUUID()}`,
    same ? `${label} ${same + 1}` : label, template.harness, role),
  ...(template.nativeTools && !switched ? { nativeTools: structuredClone(template.nativeTools) } : {}),
  ...(template.harnessProfileSelection && !switched ? { harnessProfileSelection: structuredClone(template.harnessProfileSelection) } : {}),
  [INSTALLATION_NAMES.fields.agentTools]: [...(template[INSTALLATION_NAMES.fields.agentTools] ?? newAgentForemanTools(role))] }
}

/** The Board's plus: one click on a role stages a new Agent; Save creates it. */
export function AddBoardAgentMenu({ draftKey, edit, disabled, report }: {
  draftKey: string; edit: NextDraftEdit; disabled?: boolean; report(error: unknown): void
}) {
  const defaults = useAgentDefaultsQuery()
  const catalog = useManagedHarnessCatalogQuery()
  const hasMaster = !!edit.graph.hierarchy || hierarchyNodes(edit).some(item => item.role === 'master')
  const add = (role: WorkflowAgentProductRole, label: string) => {
    try {
      if (!defaults.data) throw new Error('Agent profiles from Settings are still loading.')
      const value = defaults.data.value
      // A new Worker is only placed on the Board; the person connects it to an Orchestrator.
      // The others stay where they are; the new one appears in view, below its parent when it has one.
      const nodeId = `node-${crypto.randomUUID()}`, view = currentBoardView()
      useGraphDraftStore.getState().updateNextDraft(draftKey, current => placeNewNode(
        stageHierarchyAgent(pinBoardLayout(current), newBoardAgent(current, value, role, label, catalog.data), nodeId), nodeId, view))
    } catch (error) { report(error) }
  }
  return <ActionMenu label="Add agent" icon="plus" width={200} disabled={disabled}
    items={roles.map(([role, label]) => ({ id: role, label,
      disabled: !defaults.data || role === 'master' && hasMaster,
      ...(defaults.isError ? { description: 'Agent profiles are unavailable.' }
        : role === 'master' && hasMaster ? { description: 'This workflow already has a Master.' } : {}),
      // Stays open so several Agents can be added in a row.
      keepOpen: true, onSelect: () => add(role, label) }))} />
}

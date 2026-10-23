import { useState } from 'react'
import { Button, ConfirmDialog, Select } from '../../shared/ui/nocturne'
import { InfoHint } from '../../shared/ui/InfoHint'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useGraphDraftStore } from '../graph/store'
import { nodeTitle, type NextDraftEdit } from '../board-core'
import { applyMasterHierarchy, hierarchyNodes, removeMasterHierarchy } from './authoring'

type Props = { draftKey: string; edit: NextDraftEdit; report(error: unknown): void }
export function HierarchyEditor(props: Props) {
  return <HierarchyEditorVisit key={`${props.edit.instanceId}:${JSON.stringify(props.edit.graph.hierarchy)}:${props.edit.graph.nodes.map(node => node.id).join(':')}`} {...props} />
}

function HierarchyEditorVisit({ draftKey, edit, report }: Props) {
  const form: NonNullable<NonNullable<NextDraftEdit['workflowForms']>['hierarchy']> = edit.workflowForms?.hierarchy ?? { masterNodeId: edit.graph.hierarchy?.masterNodeId ?? '', parents: Object.fromEntries(
    edit.graph.hierarchy?.parents.map(member => [member.workflowNodeId, member.parentNodeId]) ?? []) }
  const { masterNodeId, parents } = form
  const previousMasterId = edit.graph.hierarchy?.masterNodeId
  const replacing = !!previousMasterId && masterNodeId !== previousMasterId
  const [confirmRemoval, setConfirmRemoval] = useState(false)
  const nodes = hierarchyNodes(edit, masterNodeId || undefined)
  const workers = nodes.filter(item => item.role === 'coder')
  const coordinators = nodes.filter(item => item.role === 'orchestrator' && !(replacing && form.previousMaster === 'remove' && item.node.id === previousMasterId))
  const movingWorkers = replacing ? workers.filter(item => edit.graph.hierarchy?.parents.some(member =>
    member.workflowNodeId === item.node.id && member.parentNodeId === masterNodeId)) : []
  const eligibleMasters = hierarchyNodes(edit).filter(item => item.role === 'master' || item.role === 'orchestrator')
  const missingParent = workers.some(({ node }) => !coordinators.some(item => item.node.id === parents[node.id]))
  const missingPreviousChoice = replacing && !form.previousMaster
  const originalGraph = edit.context.draft.graph
  const changedConnections = edit.graph.edges.filter(edge => !originalGraph.edges.some(original => original.id === edge.id))
  const reorientedConnections = edit.graph.edges.filter(edge => originalGraph.edges.some(original => original.id === edge.id
    && (original.source !== edge.source || original.target !== edge.target)))
  const formerParentConnections = originalGraph.edges.filter(edge => edge.kind === 'execution'
    && originalGraph.hierarchy?.parents.some(member => member.parentNodeId === edge.source && member.workflowNodeId === edge.target)
    && !edit.graph.hierarchy?.parents.some(member => member.parentNodeId === edge.source && member.workflowNodeId === edge.target)
    && edit.graph.edges.some(current => current.id === edge.id))
  const update = (action: (current: NextDraftEdit) => NextDraftEdit, clearForm = false) => {
    useGraphDraftStore.getState().updateNextDraft(draftKey, current => {
      if (current.instanceId !== edit.instanceId) throw new Error('The draft changed. Reopen Workflow settings.')
      const next = action(current)
      if (!clearForm) return next
      const workflowForms = { ...next.workflowForms }; delete workflowForms.hierarchy
      return { ...next, workflowForms }
    })
  }
  const changeForm = (change: Partial<typeof form>) => update(current => ({ ...current,
    workflowForms: { ...current.workflowForms, hierarchy: { ...(current.workflowForms?.hierarchy ?? form), ...change } } }))
  const apply = () => {
    if (missingPreviousChoice) throw new Error('Choose whether to keep or remove the previous Master.')
    update(current => applyMasterHierarchy(current, masterNodeId, parents, form.previousMaster), true)
  }
  const discard = () => update(current => current, true)
  const attempt = (action: () => void) => { try { action() } catch (error) { report(error) } }
  useUnsavedChanges({ scope: 'surface', label: 'Master hierarchy form', dirty: !!edit.workflowForms?.hierarchy,
    busy: edit.busy || !!edit.pending, saveDisabled: !masterNodeId || missingParent || missingPreviousChoice, save: apply, discard })
  return <section className="next-draft-section" aria-label="Master hierarchy">
    <h3>Master hierarchy<InfoHint label="Master hierarchy">The Master starts the workflow and delegates to Orchestrators.
      Each Worker reports to one Orchestrator. Add a Master from Add agent, or pick an existing agent here.</InfoHint></h3>
    <Select data-save-field="hierarchy" label="Master" value={masterNodeId}
      onChange={event => attempt(() => changeForm({ masterNodeId: event.target.value }))} options={[
        { value: '', label: 'None' },
        ...eligibleMasters.map(({ node }) => ({ value: node.id, label: nodeTitle(edit.graph, node.id) })),
      ]} />
    {masterNodeId ? <>
      {replacing ? <Select label="Previous Master" value={form.previousMaster ?? ''}
        options={[{ value: '', label: 'Choose what to keep' },
          { value: 'keep', label: `Keep ${nodeTitle(edit.graph, previousMasterId!)} as Orchestrator` },
          { value: 'remove', label: `Remove ${nodeTitle(edit.graph, previousMasterId!)} from workflow` }]}
        onChange={event => attempt(() => changeForm({ previousMaster: event.target.value === 'remove' ? 'remove' : 'keep' }))} /> : null}
      {movingWorkers.length ? <Select label={`Move ${movingWorkers.length} Workers to`}
        value={movingWorkers.every(item => parents[item.node.id] === parents[movingWorkers[0]!.node.id])
          && coordinators.some(item => item.node.id === parents[movingWorkers[0]!.node.id]) ? parents[movingWorkers[0]!.node.id] ?? '' : ''}
        options={[{ value: '', label: 'Choose a destination for this team' }, ...coordinators.map(({ node }) => ({
          value: node.id, label: node.id === previousMasterId ? `Previous Master · ${nodeTitle(edit.graph, node.id)}` : nodeTitle(edit.graph, node.id),
        }))]} onChange={event => { const parentNodeId = event.target.value; attempt(() => changeForm({
          parents: { ...parents, ...Object.fromEntries(movingWorkers.map(item => [item.node.id, parentNodeId])) },
        })) }} /> : null}
      {coordinators.length ? <p className="next-draft-hint">Reports to Master: {coordinators.map(({ node }) => nodeTitle(edit.graph, node.id)).join(', ')}.</p>
        : <p className="next-draft-hint">Add an Orchestrator to delegate work.</p>}
      {workers.map(({ node }) => <Select key={node.id} label={`${nodeTitle(edit.graph, node.id)} reports to`}
        value={parents[node.id] ?? ''} onChange={event => attempt(() => changeForm({ parents: { ...parents, [node.id]: event.target.value } }))}
        options={[{ value: '', label: 'Choose an Orchestrator' }, ...coordinators.map(item => ({
          value: item.node.id, label: nodeTitle(edit.graph, item.node.id),
        }))]} />)}
      {missingParent ? <p className="next-draft-hint" role="status">Choose who each Worker reports to.</p> : null}
      {missingPreviousChoice ? <p className="next-draft-hint" role="status">Choose what happens to the previous Master.</p> : null}
    </> : null}
    {masterNodeId || edit.graph.hierarchy || edit.workflowForms?.hierarchy ? <div className="n-actions">
      {masterNodeId ? <Button size="sm" disabled={missingParent || missingPreviousChoice} onClick={() => attempt(apply)}>Apply hierarchy</Button> : null}
        {edit.graph.hierarchy ? <Button size="sm" variant="ghost" className="workflow-settings-danger" onClick={() => setConfirmRemoval(true)}>Remove hierarchy</Button> : null}
    </div> : null}
    <ConfirmDialog open={confirmRemoval} onOpenChange={setConfirmRemoval} title="Remove the Master hierarchy?"
      description="The Master becomes an Orchestrator in this draft. Connections and the starting agent stay. Nothing changes until you save."
      confirmLabel="Remove hierarchy" onConfirm={() => { setConfirmRemoval(false); attempt(() => update(removeMasterHierarchy, true)) }} />
    {changedConnections.length || reorientedConnections.length || formerParentConnections.length ? <section aria-label="Changed connections">
      <h4>Changed connections · Unsaved</h4><ul>
        {changedConnections.map(edge => <li key={edge.id}>Added: {nodeTitle(edit.graph, edge.source)} → {nodeTitle(edit.graph, edge.target)}</li>)}
        {reorientedConnections.map(edge => <li key={`direction:${edge.id}`}>Reporting direction: {nodeTitle(edit.graph, edge.source)} → {nodeTitle(edit.graph, edge.target)}. The existing two-way work connection is kept.</li>)}
        {formerParentConnections.map(edge => <li key={edge.id}>Retained as ordinary handoff: {nodeTitle(edit.graph, edge.source)} → {nodeTitle(edit.graph, edge.target)}.
          Remove it explicitly in the Agent’s Connections if it is no longer needed.</li>)}
      </ul>
    </section> : null}
  </section>
}

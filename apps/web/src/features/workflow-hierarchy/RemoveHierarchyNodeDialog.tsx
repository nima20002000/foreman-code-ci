import { Button, Dialog, Select } from '../../shared/ui/nocturne'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useGraphDraftStore } from '../graph/store'
import { nodeTitle } from '../graph/nextDraft/model'
import type { NextDraftEdit } from '../graph/nextDraft/state'
import { hierarchyNodes, removeHierarchyNode } from './authoring'

export function RemoveHierarchyNodeDialog({ draftKey, edit, pending, report }: {
  draftKey: string; edit: NextDraftEdit; pending: boolean; report(error: unknown): void
}) {
  const form = edit.workflowForms?.removeNode
  const node = edit.graph.nodes.find(item => item.id === form?.nodeId)
  const master = form?.nodeId === edit.graph.hierarchy?.masterNodeId
  const workers = !master && form ? edit.graph.hierarchy?.parents.filter(member => member.parentNodeId === form.nodeId) ?? [] : []
  const destinations = hierarchyNodes(edit).filter(item => item.role === 'orchestrator' && item.node.id !== form?.nodeId)
  const valid = !!node && (!workers.length || destinations.some(item => item.node.id === form?.destinationParentId))
  const discard = () => useGraphDraftStore.getState().updateNextDraft(draftKey, current => {
    const workflowForms = { ...current.workflowForms }; delete workflowForms.removeNode
    return { ...current, workflowForms }
  })
  const apply = () => {
    if (!valid || !form) throw new Error('Choose an Orchestrator before removing the team.')
    useGraphDraftStore.getState().updateNextDraft(draftKey, current => {
      if (current.instanceId !== edit.instanceId) throw new Error('The draft changed. Reopen removal.')
      return removeHierarchyNode(current, form.nodeId, form.destinationParentId)
    })
  }
  const leave = useUnsavedChanges({ scope: 'surface', label: 'remove workflow node', dirty: !!form,
    busy: !!form && pending, saveDisabled: !valid, save: apply, discard })
  const incident = edit.graph.edges.filter(edge => edge.source === form?.nodeId || edge.target === form?.nodeId)
  const named = edit.graph.nodes.filter(item => item.id !== form?.nodeId).flatMap(item => item.choice?.outcomes.flatMap(outcome =>
    outcome.target.kind === 'edge' && incident.some(edge => outcome.target.kind === 'edge' && edge.id === outcome.target.relationshipId)
      ? [`${nodeTitle(edit.graph, item.id)} · ${outcome.outcome}`] : []) ?? [])
  const name = node ? nodeTitle(edit.graph, node.id) : 'this agent'
  return <Dialog open={!!form} onOpenChange={open => { if (!open && !pending) void leave(discard) }} size="sm" role="alertdialog"
    title={`Remove ${name}?`} closeLabel="Close removal"
    description={master ? 'It stops leading this workflow; other agents stay. Pick a new starting agent before you save.'
      : 'Its connections go too. Nothing changes until you save.'}>
    <fieldset className="n-stack" disabled={pending}>
      {workers.length ? <>
        <Select label={`Move its ${workers.length} ${workers.length === 1 ? 'worker' : 'workers'} to`} value={form?.destinationParentId ?? ''}
          options={[{ value: '', label: 'Choose an Orchestrator' }, ...destinations.map(({ node: destination }) => ({
            value: destination.id, label: nodeTitle(edit.graph, destination.id),
          }))]} onChange={event => { const destinationParentId = event.target.value
            useGraphDraftStore.getState().updateNextDraft(draftKey, current => ({ ...current, workflowForms: {
              ...current.workflowForms, removeNode: { nodeId: form!.nodeId, destinationParentId },
            } }))
          }} />
        {!destinations.length ? <p className="next-draft-hint" role="status">Add another Orchestrator first, or remove the workers.</p> : null}
      </> : null}
      {incident.length ? <p className="next-draft-hint">Removes {incident.map(edge => `${nodeTitle(edit.graph, edge.source)} → ${nodeTitle(edit.graph, edge.target)}`).join(', ')}.</p> : null}
      {named.length ? <p className="next-draft-hint">Give these outcomes a new target before saving: {named.join(', ')}.</p> : null}
      <div className="n-actions">
        <Button onClick={discard}>Cancel</Button>
        <Button variant="danger" disabled={!valid} onClick={() => { try { apply() } catch (error) { report(error) } }}>Remove</Button>
      </div>
    </fieldset>
  </Dialog>
}

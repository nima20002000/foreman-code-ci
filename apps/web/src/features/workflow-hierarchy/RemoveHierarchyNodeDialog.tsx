import { Button, Dialog, Select } from '../../shared/ui/nocturne'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useGraphDraftStore } from '../graph/store'
import { nodeTitle } from '../graph/nextDraft/model'
import type { NextDraftEdit } from '../graph/nextDraft/state'
import { pinBoardLayout } from '../graph/nextDraft/placement'
import { useBoardSelection } from '../workflow-board/context'
import { hierarchyNodes, removeHierarchyNode } from './authoring'

export function RemoveHierarchyNodeDialog({ draftKey, edit, pending, report }: {
  draftKey: string; edit: NextDraftEdit; pending: boolean; report(error: unknown): void
}) {
  const form = edit.workflowForms?.removeNode
  const board = useBoardSelection()
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
      // The remaining nodes stay where they are.
      return removeHierarchyNode(pinBoardLayout(current), form.nodeId, form.destinationParentId)
    })
    // The removed agent's panel closes with it.
    if (board?.sidePanel?.kind === 'agent' && board.sidePanel.nodeId === form.nodeId) board.selectSidePanel?.({ kind: 'none' })
  }
  const leave = useUnsavedChanges({ scope: 'surface', label: 'remove workflow node', dirty: !!form,
    busy: !!form && pending, saveDisabled: !valid, save: apply, discard })
  const incident = edit.graph.edges.filter(edge => edge.source === form?.nodeId || edge.target === form?.nodeId)
  // On a Master Board the routes of removed lines go with them; elsewhere they are named by the agents they connect.
  const named = edit.graph.hierarchy ? [] : edit.graph.nodes.filter(item => item.id !== form?.nodeId).flatMap(item => item.choice?.outcomes.flatMap(outcome => {
    const edge = outcome.target.kind === 'edge' ? incident.find(line => outcome.target.kind === 'edge' && line.id === outcome.target.relationshipId) : undefined
    return edge ? [`${nodeTitle(edit.graph, item.id)}’s route to ${nodeTitle(edit.graph, edge.source === item.id ? edge.target : edge.source)}`] : []
  }) ?? [])
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
      {named.length ? <p className="next-draft-hint">Give these routes a new target before saving: {named.join(', ')}.</p> : null}
      <div className="n-actions">
        <Button onClick={discard}>Cancel</Button>
        <Button variant="danger" disabled={!valid} onClick={() => { try { apply() } catch (error) { report(error) } }}>Remove</Button>
      </div>
    </fieldset>
  </Dialog>
}

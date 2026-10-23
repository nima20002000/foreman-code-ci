import { useState } from 'react'
import { Button, ConfirmDialog } from '../../../shared/ui/nocturne'
import { useGraphDraftStore } from '../store'
import { nodeTitle, type ConflictRecovery, type NextDraftEdit } from '../../board-core'
import { discardConflictRecovery, readConflictRecoveries } from './editIntentStorage'

export function ConflictRecoveryPanel({ draftKey, edit, pending, report }: {
  draftKey: string; edit: NextDraftEdit; pending: boolean; report(error: unknown): void
}) {
  const [selected, setSelected] = useState<string>(), [discard, setDiscard] = useState<ConflictRecovery>()
  const recoveries = edit.conflictRecovery ?? [], recovery = recoveries.find(item => item.id === selected)
  if (!recoveries.length) return null
  return <section className="next-draft-section" aria-label="Draft conflict recovery">
    <h3>Recovered drafts</h3>
    <p className="next-draft-hint">Kept after a reload. Reapply what you need, then save.</p>
    <ul className="conflict-recovery-list">{recoveries.map(item => <li key={item.id} className="workflow-settings-row">
      <span>{new Date(item.recordedAt).toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' })}</span>
      <span className="n-actions">
        <Button size="sm" variant="ghost" aria-pressed={selected === item.id} onClick={() => setSelected(selected === item.id ? undefined : item.id)}>
          {selected === item.id ? 'Hide' : 'Compare'}</Button>
        <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDiscard(item)}>Discard</Button>
      </span>
    </li>)}</ul>
    {recovery ? <table className="conflict-recovery-table" aria-label="Recovered draft compared with the current draft">
      <thead><tr><th scope="col"></th><th scope="col">Recovered</th><th scope="col">Current</th></tr></thead>
      <tbody><tr><th scope="row">Name</th><td>{recovery.snapshot.graph.name}</td><td>{edit.graph.name}</td></tr>
        <tr><th scope="row">Master</th><td>{recovery.snapshot.graph.hierarchy ? nodeTitle(recovery.snapshot.graph, recovery.snapshot.graph.hierarchy.masterNodeId) : 'None'}</td><td>{edit.graph.hierarchy ? nodeTitle(edit.graph, edit.graph.hierarchy.masterNodeId) : 'None'}</td></tr>
        <tr><th scope="row">Agents</th><td>{recovery.snapshot.graph.nodes.map(node => nodeTitle(recovery.snapshot.graph, node.id)).join(', ') || 'None'}</td><td>{edit.graph.nodes.map(node => nodeTitle(edit.graph, node.id)).join(', ') || 'None'}</td></tr>
        <tr><th scope="row">Connections</th><td>{recovery.snapshot.graph.edges.length}</td><td>{edit.graph.edges.length}</td></tr>
      </tbody></table> : null}
    <ConfirmDialog open={!!discard} onOpenChange={open => { if (!open) setDiscard(undefined) }}
      title="Discard this recovered draft?" description="Only this recovered copy is removed. Your current draft stays."
      confirmLabel="Discard" onConfirm={() => {
        if (!discard) return
        try {
          discardConflictRecovery(draftKey, discard)
          const conflictRecovery = readConflictRecoveries(draftKey)
          useGraphDraftStore.getState().updateNextDraft(draftKey, state => ({ ...state, conflictRecovery }))
          if (selected === discard.id) setSelected(undefined)
          setDiscard(undefined)
        } catch (error) { report(error) }
      }} />
  </section>
}

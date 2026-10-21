import { useState } from 'react'
import { Button, ConfirmDialog } from '../../../shared/ui/nocturne'
import { useGraphDraftStore } from '../store'
import { nodeTitle } from './model'
import { discardConflictRecovery, readConflictRecoveries } from './editIntentStorage'
import type { ConflictRecovery, NextDraftEdit } from './state'

export function ConflictRecoveryPanel({ draftKey, edit, pending, report }: {
  draftKey: string; edit: NextDraftEdit; pending: boolean; report(error: unknown): void
}) {
  const [selected, setSelected] = useState<string>(), [discard, setDiscard] = useState<ConflictRecovery>()
  const recoveries = edit.conflictRecovery ?? [], recovery = recoveries.find(item => item.id === selected)
  if (!recoveries.length) return null
  return <section className="next-draft-section" aria-label="Draft conflict recovery">
    <h3>Recovered drafts</h3>
    <p className="next-draft-hint">Unsaved drafts kept after a reload. Reapply the changes you want, then save.</p>
    <ul>{recoveries.map(item => <li key={item.id}>
      <span>Unsaved draft · {new Date(item.recordedAt).toLocaleString()}</span>{' '}
      <Button size="sm" onClick={() => setSelected(item.id)}>View unsaved draft</Button>{' '}
      <Button size="sm" variant="ghost" disabled={pending} onClick={() => setDiscard(item)}>Discard recovered draft</Button>
    </li>)}</ul>
    {recovery ? <section aria-label="Read-only recovered draft">
      <header><h4>Unsaved draft — read-only</h4><Button size="sm" variant="ghost" onClick={() => setSelected(undefined)}>Close comparison</Button></header>
      <p>This copy is kept until you explicitly discard it. It is separate from the current edit base.</p>
      <table><caption>Recovered draft and current editor</caption><thead><tr><th>Field</th><th>Recovered</th><th>Current editor</th></tr></thead>
        <tbody><tr><th>Workflow</th><td>{recovery.snapshot.graph.name}</td><td>{edit.graph.name}</td></tr>
          <tr><th>Master node</th><td>{recovery.snapshot.graph.hierarchy ? nodeTitle(recovery.snapshot.graph, recovery.snapshot.graph.hierarchy.masterNodeId) : 'No Master'}</td><td>{edit.graph.hierarchy ? nodeTitle(edit.graph, edit.graph.hierarchy.masterNodeId) : 'No Master'}</td></tr>
          <tr><th>Nodes / connections</th><td>{recovery.snapshot.graph.nodes.length} / {recovery.snapshot.graph.edges.length}</td><td>{edit.graph.nodes.length} / {edit.graph.edges.length}</td></tr>
        </tbody></table>
      <details><summary>All recovered fields</summary><p>Use these retained values for manual comparison. This view cannot save or replace the current draft.</p>
        <pre tabIndex={0}>{JSON.stringify({ graph: recovery.snapshot.graph,
          agentEdits: recovery.snapshot.agentEdits ?? {}, unsavedAgentForms: recovery.snapshot.agentForms ?? {},
          unsavedWorkflowForms: recovery.snapshot.workflowForms ?? {} }, null, 2)}</pre>
      </details>
    </section> : null}
    <ConfirmDialog open={!!discard} onOpenChange={open => { if (!open) setDiscard(undefined) }}
      title="Discard this recovered draft?" description="Only this read-only recovery is removed. Other recoveries and the current editor are kept."
      confirmLabel="Discard recovered draft" onConfirm={() => {
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

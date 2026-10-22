import { InfoHint } from '../../../shared/ui'
import { Button, Icon, IconButton, TextField } from '../../../shared/ui/nocturne'
import { AgentActiveTimeField } from './AgentActiveTimeField'
import { ApprovalFields, EntryFields, type EditGraph } from './AuthoringFields'
import type { NextDraftEdit } from './state'
import { HierarchyEditor } from '../../workflow-hierarchy/HierarchyEditor'

export function WorkflowSettings({ draftKey, edit, change, report, defaultMs, locationReady, locationMessage,
  onChangeFolder, onReload }: {
  edit: NextDraftEdit
  draftKey: string
  change: EditGraph
  report(error: unknown): void
  defaultMs: number | undefined
  locationReady: boolean
  locationMessage: string
  onChangeFolder: (() => void) | undefined
  onReload(): void
}) {
  const { graph, context, agentEdits } = edit
  return <div className="workflow-settings">
    <HierarchyEditor draftKey={draftKey} edit={edit} report={report} />
    {graph.hierarchy ? null : <EntryFields graph={graph} context={context} agentEdits={agentEdits} change={change} />}
    <ApprovalFields graph={graph} context={context} agentEdits={agentEdits} change={change} report={report} />
    <section className="next-draft-section" aria-label="Limits">
      <h3>Limits{graph.handoffs ? <InfoHint label="Limits">Set each work connection’s handoff limit on its line on the Board.</InfoHint> : null}</h3>
      {graph.executionPolicy ? <>
        <AgentActiveTimeField policy={graph.executionPolicy} defaultMs={defaultMs}
          onChange={(executionPolicy) => change((item) => ({ ...item, executionPolicy }))} />
        <TextField data-save-field="limits" label="Agents at once" type="number" min={1} max={100}
          value={Number.isFinite(graph.executionPolicy.maxParallelism) ? graph.executionPolicy.maxParallelism : ''}
          onChange={(event) => {
            const value = event.target.valueAsNumber
            change((item) => ({ ...item, executionPolicy: { ...item.executionPolicy!, maxParallelism: value } }))
          }} />
        <TextField data-save-field="executions" label="Agent turns per run" type="number" min={1} max={10000}
          value={Number.isFinite(graph.executionPolicy.maxNodeExecutions) ? graph.executionPolicy.maxNodeExecutions : ''}
          onChange={(event) => {
            const value = event.target.valueAsNumber
            change((item) => ({ ...item, executionPolicy: { ...item.executionPolicy!, maxNodeExecutions: value } }))
          }} />
      </> : <div className="workflow-settings-row" data-tone="warning"><span>Required before saving</span>
        <Button data-save-field="limits" size="sm" variant="ghost" onClick={() => change((item) => ({ ...item,
          executionPolicy: { maxParallelism: Number.NaN, maxNodeExecutions: Number.NaN } }))}>Set limits</Button></div>}
      {graph.requiredAgentCount !== undefined ? <div className="workflow-settings-row">
        <TextField label="Required agents" type="number" min={0} max={10000}
          value={Number.isFinite(graph.requiredAgentCount) ? graph.requiredAgentCount : ''}
          onChange={(event) => {
            const requiredAgentCount = event.target.valueAsNumber
            change((item) => ({ ...item, requiredAgentCount }))
          }} />
        <IconButton size="sm" variant="ghost" label="Remove required agents" onClick={() => change((item) => {
          const next = { ...item }
          delete next.requiredAgentCount
          return next
        })}><Icon name="close" size={14} /></IconButton>
      </div> : null}
    </section>
    <section className="next-draft-section" aria-label="Folder">
      <h3>Folder</h3>
      <div className="workflow-settings-row" data-tone={locationReady ? undefined : 'warning'}>
        <span>{locationReady ? 'Workspace folder' : locationMessage}</span>
        <Button size="sm" variant="ghost" onClick={onChangeFolder}>{locationReady ? 'Change' : 'Choose folder'}</Button>
      </div>
    </section>
    {context.draft.baseWorkflowVersionId ? <section className="next-draft-section" aria-label="Saved version">
      <h3>Saved version</h3>
      <div className="workflow-settings-row"><span>Open the latest save. Your edits are kept to compare.</span>
        <Button size="sm" variant="ghost" disabled={!!edit.pending} onClick={onReload}>Reload</Button></div>
    </section> : null}
  </div>
}

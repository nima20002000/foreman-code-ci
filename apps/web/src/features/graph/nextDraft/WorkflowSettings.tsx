import { DEFAULT_WORKFLOW_EXECUTION_POLICY } from '@foreman-code/contracts/wave25'
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
  // A workflow without saved limits shows the defaults it starts with; any edit saves them.
  const policy = graph.executionPolicy ?? DEFAULT_WORKFLOW_EXECUTION_POLICY
  // Turns per run only bound agents that hand work to each other; one unconnected agent runs once.
  const connected = graph.edges.some(edge => edge.kind === 'execution')
  return <div className="workflow-settings">
    <HierarchyEditor draftKey={draftKey} edit={edit} report={report} />
    {graph.hierarchy ? null : <EntryFields graph={graph} context={context} agentEdits={agentEdits} change={change} />}
    <ApprovalFields graph={graph} context={context} agentEdits={agentEdits} change={change} report={report} />
    <section className="next-draft-section" aria-label="Limits">
      <h3>Limits{graph.handoffs && connected ? <InfoHint label="Limits">Set each work connection’s handoff limit on its line on the Board.</InfoHint> : null}</h3>
      <AgentActiveTimeField policy={policy} defaultMs={defaultMs}
        onChange={(executionPolicy) => change((item) => ({ ...item, executionPolicy }))} />
      <TextField data-save-field="limits" label="Agents at once" type="number" min={1} max={100}
        value={Number.isFinite(policy.maxParallelism) ? policy.maxParallelism : ''}
        onChange={(event) => {
          const value = event.target.valueAsNumber
          change((item) => ({ ...item, executionPolicy: { ...(item.executionPolicy ?? DEFAULT_WORKFLOW_EXECUTION_POLICY), maxParallelism: value } }))
        }} />
      {connected ? <TextField data-save-field="executions" label="Agent turns per run" type="number" min={1} max={10000}
        value={Number.isFinite(policy.maxNodeExecutions) ? policy.maxNodeExecutions : ''}
        onChange={(event) => {
          const value = event.target.valueAsNumber
          change((item) => ({ ...item, executionPolicy: { ...(item.executionPolicy ?? DEFAULT_WORKFLOW_EXECUTION_POLICY), maxNodeExecutions: value } }))
        }} /> : null}
      {graph.executionPolicy ? null : <div className="workflow-settings-row" data-tone="warning"><span>Default limits, not saved yet</span>
        <Button size="sm" variant="ghost" onClick={() => change((item) => ({ ...item,
          executionPolicy: { ...DEFAULT_WORKFLOW_EXECUTION_POLICY } }))}>Use these</Button></div>}
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

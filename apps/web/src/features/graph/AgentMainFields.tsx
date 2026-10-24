import type { ReactNode } from 'react'
import {
  AgentEffortSchema, ClaudeEffortSchema, changeCodexSandbox, effectiveForemanTools, memoryBoardTools, ForemanAgentToolSchema,
  type ForemanAgentTool, type ForemanToolOverride, type HarnessConfiguration, type RecordedHarnessConfiguration, type WorkflowAgentProductRole,
} from '@foreman-code/contracts'
import { Combobox, Select, Switch } from '../../shared/ui/nocturne'
import { useProviderHarnessModels } from '../provider-accounts'
import { selectNativeModel, supportedEfforts, claudeAccessOptions, fieldMessage, type FieldIssue } from '../settings'
import { memoryAccess, memoryToolNames, replaceMemoryAccess } from '../memory-boards'
import type { DeviceProvisioningTarget } from '@foreman-code/contracts/device-resources'

/** One compact settings row: a plain label on the left, its control on the right, an optional note below. */
export function NodeRow({ label, children, note, tone }: { label: string; children: ReactNode; note?: ReactNode; tone?: 'warning' }) {
  return <div className="agent-node-row">
    <span className="agent-node-row-label" aria-hidden="true">{label}</span>
    <div className="agent-node-row-control">{children}</div>
    {note ? <p className="agent-node-row-note" data-tone={tone}>{note}</p> : null}
  </div>
}

const codexAccess = [{ value: 'read-only', label: 'Read only' }, { value: 'workspace-write', label: 'Workspace write' },
  { value: 'danger-full-access', label: 'Full access' }]

/** Model, effort, access and fast mode for the selected harness. Account and sign-in live under More settings. */
function EditableAgentHarnessRows({ value, onChange, issues = [], accountHost }: {
  value: HarnessConfiguration; onChange(value: HarnessConfiguration): void; issues?: readonly FieldIssue[]
  accountHost?: DeviceProvisioningTarget['hostRef'] | undefined
}) {
  const query = useProviderHarnessModels(value.harness, value.accountId, accountHost)
  const models = query.data?.models ?? []
  const selected = models.find(model => model.id === value.model)
  const modelOptions: { value: string; label: string; description?: string; disabled?: boolean }[] = models.map(model => ({ value: model.id, label: model.name || model.id }))
  if (!modelOptions.some(option => option.value === value.model)) modelOptions.unshift({ value: value.model,
    label: value.model || 'Choose a model', description: query.isPending ? 'Loading models…' : 'Saved model', disabled: true })
  const modelsNote = query.isError ? `Model list unavailable: ${query.error?.message ?? 'try again shortly.'}` : undefined
  const knownEfforts = value.harness === 'claude'
    ? selected?.reasoningEfforts?.filter(effort => ClaudeEffortSchema.safeParse(effort).success) ?? ClaudeEffortSchema.options
    : selected ? supportedEfforts(selected) : AgentEffortSchema.options.filter(effort => !['none', 'minimal', 'ultra'].includes(effort))
  const effort = value.harness === 'claude' ? value.effort ?? '' : value.reasoningEffort
  const effortOptions = [...(value.harness === 'claude' ? [{ value: '', label: 'Default' }] : []),
    ...[...new Set([...knownEfforts, ...(effort ? [effort] : [])])].map(item => ({ value: item, label: item }))]
  const fastSupported = value.harness === 'codex' && (!selected || selected.serviceTiers.includes('priority'))
  return <>
    <NodeRow label="Model" note={modelsNote} tone="warning">
      <Combobox label="Model" value={value.model} options={modelOptions} error={fieldMessage(issues, 'model')}
        onValueChange={id => {
          const model = models.find(item => item.id === id)
          if (model) onChange(selectNativeModel(value, model))
        }} />
    </NodeRow>
    <NodeRow label="Effort">
      <Select label="Effort" className="agent-node-inline" value={effort} options={effortOptions}
        error={fieldMessage(issues, value.harness === 'claude' ? 'effort' : 'reasoningEffort')}
        onChange={event => onChange(value.harness === 'claude'
          ? { ...value, effort: event.target.value ? ClaudeEffortSchema.parse(event.target.value) : undefined }
          : { ...value, reasoningEffort: AgentEffortSchema.parse(event.target.value) })} />
    </NodeRow>
    <NodeRow label="Access">
      <Select label="Access" className="agent-node-inline" value={value.sandbox} error={fieldMessage(issues, 'sandbox')}
        options={value.harness === 'claude' ? claudeAccessOptions(value.sandbox) : codexAccess}
        onChange={event => {
          const sandbox = event.target.value as typeof value.sandbox
          onChange(value.harness === 'codex' ? changeCodexSandbox(value, sandbox) : { ...value, sandbox })
        }} />
    </NodeRow>
    {value.harness === 'codex' ? <NodeRow label="Fast mode"
      note={fieldMessage(issues, 'serviceTier') ?? (!fastSupported && value.serviceTier === 'priority' ? 'This model has no fast mode. Turn it off.' : undefined)} tone="warning">
      <Switch label="Fast mode" className="agent-node-inline" checked={value.serviceTier === 'priority'}
        disabled={!fastSupported && value.serviceTier !== 'priority'}
        onChange={event => onChange({ ...value, serviceTier: event.target.checked ? 'priority' : 'standard' })} />
    </NodeRow> : null}
  </>
}

const memoryLabels = { none: 'Off', read: 'Read', write: 'Read and write', custom: 'Custom' } as const

/** Memory board access for this node, stored as the node's change to the Agent's default tools. */
export function AgentMemoryRow({ role, defaults, override, readOnly, onChange }: {
  role: WorkflowAgentProductRole; defaults: readonly ForemanAgentTool[] | undefined; override: ForemanToolOverride | undefined
  readOnly: boolean; onChange(defaults: ForemanAgentTool[] | undefined, override: ForemanToolOverride | undefined): void
}) {
  const memoryTools: ForemanAgentTool[] = memoryBoardTools('write')
  const agentDefault = effectiveForemanTools(role, defaults, undefined, false, memoryTools)
  const changed = Boolean(override?.add.some(tool => memoryTools.includes(tool)) || override?.remove.some(tool => memoryTools.includes(tool)))
  const effective = changed ? effectiveForemanTools(role, defaults, override, false, memoryTools) : agentDefault
  const access = memoryAccess(effective)
  return <NodeRow label="Memory" note={readOnly && access !== 'none' && access !== 'read' ? 'Read-only agents can only read memory.' : undefined}>
    <Select label="Memory" className="agent-node-inline" value={changed ? access : 'inherit'}
      options={[{ value: 'inherit', label: `Default (${memoryLabels[memoryAccess(agentDefault)]})` },
        { value: 'none', label: 'Off' }, { value: 'read', label: 'Read' }, { value: 'write', label: 'Read and write' },
        ...(changed && access === 'custom' ? [{ value: 'custom', label: 'Custom', disabled: true }] : [])]}
      onChange={event => {
        const choice = event.target.value
        if (choice === 'custom') return
        const next = choice === 'inherit' ? agentDefault
          : replaceMemoryAccess(effective, choice as 'none' | 'read' | 'write').filter(tool => memoryToolNames.includes(tool))
        const add = (override?.add ?? []).filter(tool => !memoryTools.includes(tool))
        const remove = (override?.remove ?? []).filter(tool => !memoryTools.includes(tool))
        for (const tool of memoryTools) {
          if (next.includes(tool) && !agentDefault.includes(tool)) add.push(ForemanAgentToolSchema.parse(tool))
          if (!next.includes(tool) && agentDefault.includes(tool)) remove.push(ForemanAgentToolSchema.parse(tool))
        }
        onChange(defaults ? [...defaults] : undefined, add.length || remove.length ? { add, remove } : undefined)
      }} />
  </NodeRow>
}

export function AgentHarnessRows(props: Omit<Parameters<typeof EditableAgentHarnessRows>[0], 'value'> & { value: RecordedHarnessConfiguration }) {
  if (props.value.harness === 'opencode') return null
  return <EditableAgentHarnessRows {...props} value={props.value} />
}

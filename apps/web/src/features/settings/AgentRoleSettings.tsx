import { INSTALLATION_NAMES } from '@foreman-code/contracts/installation-names'
import {
  agentTemplateForRole, DEFAULT_HARNESS_DEFAULTS, memoryBoardTools, nativeToolsSummary, newAgentForemanTools,
  operatorHarnessDefaults, type AgentDefaults, type RecordedHarnessConfiguration,
} from '@foreman-code/contracts'
import type { SettingsAgentRole } from '@foreman-code/contracts/management'
import { Button, ErrorState, LoadingState, Select, SettingRow, SettingsSection, Switch } from '../../shared/ui/nocturne'
import { useAgentDefaultsQuery, useHarnessDefaultsQuery, useUpdateAgentDefaultsMutation } from '../../shared/api/query'
import { HarnessBasicFields } from './HarnessBasicFields'
import { SettingsFormActions, SettingsFormFeedback } from './SettingsFormActions'
import { useRevisionedForm } from './revisionedForm'
import { rolePresentation } from './settingsPresentation'
import './settingsExperience.css'

type Template = AgentDefaults['operator'] | NonNullable<AgentDefaults['master']> | AgentDefaults['orchestrator'] | AgentDefaults['coder']
type Memory = 'none' | 'write'
const harnessOptions = [{ value: 'codex', label: 'Codex' }, { value: 'claude', label: 'Claude' }] as const
// Agent memory on is read and write; a workflow node or read-only access narrows it to read.
const memoryOptions = [{ value: 'none', label: 'Off' }, { value: 'write', label: 'Read and write' }] as const

function templateFor(value: AgentDefaults, role: SettingsAgentRole): Template {
  return role === 'operator' ? value.operator : agentTemplateForRole(value, role)
}
function withTemplate(value: AgentDefaults, role: SettingsAgentRole, template: Template): AgentDefaults {
  return { ...value, [role]: template }
}
function memoryOf(tools: readonly string[]): Memory {
  return memoryBoardTools('write').some(tool => tools.includes(tool)) ? 'write' : 'none'
}

/** One role's defaults, edited in place and saved with the same revision-checked mutation the Operator uses. */
export function AgentRoleSettings({ role, onEditPrompt }: { role: SettingsAgentRole; onEditPrompt(): void }) {
  const query = useAgentDefaultsQuery()
  const presets = useHarnessDefaultsQuery()
  const mutation = useUpdateAgentDefaultsMutation()
  const form = useRevisionedForm<AgentDefaults>(query.data, 'settings:agent-defaults')
  const title = rolePresentation[role].title
  if (query.isError && !form.draft) return <ErrorState title="Agent defaults are unavailable" description={query.error.message} onRetry={() => void query.refetch()} />
  if (!form.draft) return <LoadingState label="Loading agent defaults…" />
  const draft = form.draft
  const template = templateFor(draft, role)
  const saved = query.data ? templateFor(query.data.value, role) : undefined
  const busy = form.isSaving || form.uncertain
  const change = (next: Template) => form.setDraft(withTemplate(draft, role, next))
  const changeHarness = (harness: 'codex' | 'claude') => {
    if (harness === template.harness.harness) return
    const preset = harness === saved?.harness.harness ? saved.harness
      : presets.data?.defaults[harness] ?? DEFAULT_HARNESS_DEFAULTS[harness]
    if (!preset) return
    const next = { ...template, harness: role === 'operator' && preset !== saved?.harness ? operatorHarnessDefaults(preset) : preset }
    delete next.harnessProfileSelection
    change(next)
  }
  const tools = role === 'operator' ? [] : template[INSTALLATION_NAMES.fields.agentTools] ?? newAgentForemanTools(role)
  const changeMemory = (memory: Memory) => {
    if (role === 'operator') return
    const kept = tools.filter(tool => !(memoryBoardTools('write') as string[]).includes(tool))
    const foremanTools = [...kept, ...(memory === 'none' ? [] : memoryBoardTools(memory))]
    const defaults = newAgentForemanTools(role)
    const next = { ...template, [INSTALLATION_NAMES.fields.agentTools]: foremanTools } as Template
    // Back at the role's built-in tools: keep following the built-in list instead of pinning a copy.
    if (saved && !(INSTALLATION_NAMES.fields.agentTools in saved && saved[INSTALLATION_NAMES.fields.agentTools]) && foremanTools.length === defaults.length
      && defaults.every(tool => foremanTools.includes(tool))) delete (next as { [INSTALLATION_NAMES.fields.agentTools]?: unknown })[INSTALLATION_NAMES.fields.agentTools]
    change(next)
  }
  const operator = role === 'operator' ? draft.operator : undefined
  return <section className="settings-editor-page agent-role-settings" aria-label={`${title} defaults`}>
    <header className="settings-experience-heading"><h1>{title}</h1>
      <p>{role === 'operator' ? 'Used by the Operator chat.' : `Used by new ${title} agents. Existing agents keep their settings.`}</p></header>
    <SettingsFormFeedback form={form} />
    <SettingsSection title="Model" description="Harness, model, effort, access and speed.">
      <SettingRow title="Harness">
        <Select label="Harness" className="settings-inline-field" value={template.harness.harness} disabled={busy}
          options={harnessOptions.map(option => ({ ...option,
            disabled: option.value === 'claude' && option.value !== saved?.harness.harness && !presets.data?.defaults.claude }))}
          onChange={event => changeHarness(event.target.value as 'codex' | 'claude')} />
      </SettingRow>
      <HarnessBasicFields value={template.harness} issues={form.issues}
        onChange={(harness: RecordedHarnessConfiguration) => change({ ...template, harness })} />
    </SettingsSection>
    <SettingsSection title="Tools" description={`Native tools: ${nativeToolsSummary(template.nativeTools)}.`}>
      {role === 'operator' ? null : <SettingRow title="Memory board" description="What this role can do with workspace memory.">
        <Select label="Memory board" className="settings-inline-field" value={memoryOf(tools)} options={memoryOptions} disabled={busy}
          onChange={event => changeMemory(event.target.value as Memory)} />
      </SettingRow>}
      {operator ? <SettingRow title="Operator chat" description="Show the Operator chat button.">
        <Switch label="Show Operator chat" checked={operator.uiEnabled} disabled={busy}
          onChange={event => change({ ...operator, uiEnabled: event.target.checked })} />
      </SettingRow> : null}
      {operator && operator.harness.harness === 'codex' ? <SettingRow title="Thinking" description="Show the Operator's reasoning in the chat.">
        <Switch label="Show thinking" checked={operator.showThinking ?? false} disabled={busy}
          onChange={event => change({ ...operator, showThinking: event.target.checked })} />
      </SettingRow> : null}
    </SettingsSection>
    {role === 'operator' ? <SettingsSection title="Initial prompt" description="New Operator conversations start with this prompt.">
      <SettingRow title="Prompt"><Button size="sm" onClick={onEditPrompt}>Edit prompt</Button></SettingRow>
    </SettingsSection> : null}
    <SettingsFormActions form={form} saveLabel={`Save ${title} settings`} onSave={() => form.save(async input => {
      const response = await mutation.mutateAsync(input)
      return response.value
    })} />
  </section>
}

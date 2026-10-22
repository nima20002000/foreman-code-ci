import { InfoHint } from '../../shared/ui/InfoHint'
import { errorMessage } from '../../shared/errorMessage'
import { sameWorkflowValue } from '@foreman-code/contracts/wave25'
import { SavedNodePlacementSchema, type SavedNodePlacement } from '@foreman-code/contracts/node-placement'
import {
  AgentWorktreeSettingsSchema, type AgentWorktreeSettings, type WorkflowWorktreeSettings,
} from '@foreman-code/contracts/worktree-settings'
import { NodePlacementField, type NodePlacementOption, type UnavailableComputer } from '../node-placement/NodePlacementField'
import type { AgentForm } from './nextDraft/agentForm'
import { useUnsavedChanges } from '../../shared/ui/unsavedChanges'
import { useEffect, useRef, useState, type ReactNode } from 'react'
import {
  AgentHarnessSchema, CodexSessionCompatibilitySchema, agentTemplateForRole, legacyEffortForHarness,
  validateHarnessWorkflowCompatibility, withAdvancedDefaults,
  type Agent, type ApprovalHandler, type AssignedSkill, type GraphqlToolOverride, type HarnessDefaults, type WorkflowExecutionPolicy,
} from '@foreman-code/contracts'

import { Alert, Button, Icon, IconButton, Select, Textarea, TextField } from '../../shared/ui/nocturne'
import { configuredHarness, initialModel } from '../agents/agentSettings'
import { useAgentDefaultsQuery, useHarnessDefaultsQuery, useManagedHarnessCatalogQuery } from '../../shared/api/query'
import { ClaudeFullAccessConfigurationSchema } from '@foreman-code/contracts/claude'
import { harnessNames, retiredHarnessLabel } from '../settings/settingsPresentation'
import { HarnessConfigurationFields } from '../settings/HarnessConfigurationFields'
import { createHarnessEditor, prepareHarnessEditor } from '../settings/harnessEditor'
import { FieldValidationError, fieldMessage, focusFirstInvalid, issuesAt, validationIssues, type FieldIssue } from '../settings/fieldValidation'
import { ProviderAccountSelect } from '../provider-accounts/ProviderAccountSelect'
import { GraphqlToolsFields } from './GraphqlToolsFields'
import { AgentHarnessRows, AgentMemoryRow, NodeRow } from './AgentMainFields'
import { harnessSwitchPreset, switchAgentHarness } from './harnessSwitch'
import { AgentSkillsField } from '../skills/AgentSkillsField'
import './agentSettingsPanel.css'

type EditableAgentSettingsFormProps = {
  /** Inside an agent popover: the popover owns the title and close button. */
  embedded?: boolean
  additionalDirty?: boolean
  additionalFields?: ReactNode
  /** Node rows shown with the main settings (browser). */
  mainFields?: ReactNode
  /** Node settings folded under More settings (workflow start, routes). */
  moreFields?: ReactNode
  /** Paired computers that can't run this Agent, with the plain reason. */
  unavailableComputers?: readonly UnavailableComputer[]
  /** Why computer choices can't be read right now. */
  placementNote?: string
  nodePlacement?: SavedNodePlacement
  nodeWorktree?: AgentWorktreeSettings
  workflowWorktree?: WorkflowWorktreeSettings
  workflowWorktreeLabel?: string
  worktreeDisabled?: boolean
  placementOptions?: readonly NodePlacementOption[]
  /** Placement access was denied: hide its details but keep the retained draft base and edits. */
  placementHidden?: boolean
  placementOptionsState?: 'ready' | 'loading' | 'unavailable'
  placementStage?: 'draft' | 'saved'
  retainedForm?: AgentForm
  onFormChange?(form: AgentForm): void
  onDiscardForm?(): void
  canResume?(): boolean
  agent: Agent
  initialPrompt?: string
  /** This workflow node's change to the Agent's default Foreman Code MCP tools. */
  nodeGraphqlTools?: GraphqlToolOverride
  creationDefaults?: HarnessDefaults
  onClose(): void
  onRemove?(): void
  onSave(agent: Agent, initialPrompt: string | undefined, executionPolicy: WorkflowExecutionPolicy,
    nodeGraphqlTools: GraphqlToolOverride | undefined, placement?: SavedNodePlacement, worktree?: AgentWorktreeSettings): void
  executionPolicy?: WorkflowExecutionPolicy
  workflowNodeCount?: number
  workspaceId?: string
  workflowApprovalHandler?: ApprovalHandler
  designatedOrchestrator?: boolean
}

function useAgentSettingsForm({ agent, initialPrompt, nodeGraphqlTools, creationDefaults, onClose, onSave, retainedForm, onFormChange, onDiscardForm, canResume, additionalDirty = false,
  nodePlacement, nodeWorktree,
  executionPolicy = { maxNodeExecutions: 1, maxParallelism: 1 },
  workflowApprovalHandler, designatedOrchestrator = false,
}: EditableAgentSettingsFormProps) {
  const [localName, setLocalName] = useState(agent.name)
  const [localPrompt, setLocalPrompt] = useState(initialPrompt ?? '')
  const [localGraphqlTools, setLocalGraphqlTools] = useState<NonNullable<AgentForm['graphqlTools']>>(() => ({
    ...(agent.graphqlTools ? { defaults: agent.graphqlTools } : {}), ...(nodeGraphqlTools ? { override: nodeGraphqlTools } : {}) }))
  const [localInstructions, setLocalInstructions] = useState(agent.prompt?.system ?? '')
  const [localSkills, setLocalSkills] = useState<AssignedSkill[]>(agent.assignedSkills ?? [])
  const [error, setError] = useState<string>()
  const [issues, setIssues] = useState<FieldIssue[]>([])
  const [moreOpen, setMoreOpen] = useState(false)
  const root = useRef<HTMLDivElement>(null)
  useEffect(() => { if (issues.length) focusFirstInvalid(root.current) }, [issues])
  const [localEditor, setLocalEditor] = useState(() => {
    const harness = agent.harnessConfiguration?.harness ?? agent.harness ?? 'codex'
    return createHarnessEditor(agent.harnessConfiguration ?? configuredHarness(agent, harness,
      initialModel(agent, harness), agent.effort ?? 'medium', agent.fastMode ?? false, 'read-only', creationDefaults))
  })
  const [localPlacement, setLocalPlacement] = useState(nodePlacement)
  const [localPrefix, setLocalPrefix] = useState(nodeWorktree?.branchPrefix ?? '')
  const base = JSON.stringify({ agent, initialPrompt, nodeGraphqlTools, nodePlacement, nodeWorktree })
  const retained = retainedForm && sameWorkflowValue(JSON.parse(retainedForm.base), JSON.parse(base)) ? retainedForm : undefined
  const name = retained?.name ?? localName, prompt = retained?.prompt ?? localPrompt, editor = retained?.editor ?? localEditor
  const placement = retained ? retained.placement : localPlacement
  const branchPrefix = retained?.branchPrefix ?? localPrefix
  const graphqlTools = retained?.graphqlTools ?? localGraphqlTools
  const instructions = retained?.instructions ?? localInstructions, skills = retained?.skills ?? localSkills
  const changeForm = (patch: Partial<AgentForm>) => onFormChange?.({ base, name, prompt, editor, graphqlTools,
    instructions, skills, branchPrefix, ...(placement ? { placement } : {}), ...patch })
  const setName = (value: string) => { if (onFormChange) changeForm({ name: value }); else setLocalName(value) }
  const setPrompt = (value: string) => { if (onFormChange) changeForm({ prompt: value }); else setLocalPrompt(value) }
  const setGraphqlTools = (value: NonNullable<AgentForm['graphqlTools']>) => { if (onFormChange) changeForm({ graphqlTools: value }); else setLocalGraphqlTools(value) }
  const setInstructions = (value: string) => { if (onFormChange) changeForm({ instructions: value }); else setLocalInstructions(value) }
  const setSkills = (value: AssignedSkill[]) => { if (onFormChange) changeForm({ skills: value }); else setLocalSkills(value) }
  const setEditor = (update: typeof editor | ((current: typeof editor) => typeof editor)) => {
    const value = typeof update === 'function' ? update(editor) : update
    if (onFormChange) changeForm({ editor: value }); else setLocalEditor(value)
  }
  const initialSnapshot = useRef<string | undefined>(undefined)
  if (!initialSnapshot.current) initialSnapshot.current = JSON.stringify({ name: agent.name, prompt: initialPrompt ?? '', editor: localEditor, graphqlTools: localGraphqlTools,
    instructions: agent.prompt?.system ?? '', skills: agent.assignedSkills ?? [], placement: nodePlacement,
    branchPrefix: nodeWorktree?.branchPrefix ?? '' })
  const defaultsQuery = useHarnessDefaultsQuery({ enabled: !creationDefaults })
  const catalogQuery = useManagedHarnessCatalogQuery(!creationDefaults)
  const providerDefaults = creationDefaults ?? defaultsQuery.data?.defaults
  const agentDefaults = useAgentDefaultsQuery(!creationDefaults)
  const role: 'master' | 'orchestrator' | 'coder' = agent.productRole === 'master' || agent.productRole === 'orchestrator' ? agent.productRole : 'coder'
  const roleDefault = agentDefaults.data ? agentTemplateForRole(agentDefaults.data.value, role).harness : undefined
  const configuration = withAdvancedDefaults(editor.configuration)
  const harnessOptions = AgentHarnessSchema.options.map((harness) => {
    const draft = editor.drafts?.[harness]
    const preset = draft?.configuration ?? providerDefaults?.[harness]
    let reason: string | undefined
    if (!draft) {
      if (!creationDefaults && defaultsQuery.isError) reason = defaultsQuery.error.message
      else if (!creationDefaults && defaultsQuery.isPending) reason = 'Provider presets are loading.'
      else if (!preset) reason = `Configure ${harnessNames[harness]} in Settings > Harnesses before selecting it.`
      else if (!creationDefaults) {
        const discoveryError = catalogQuery.data?.find((entry) => entry.harness === harness)?.discoveryError
        if (discoveryError && ['HARNESS_MODEL_DEFAULT_UNAVAILABLE', 'CLAUDE_FULL_ACCESS_REQUIRED',
          'CLAUDE_EXTERNAL_MCP_UNSUPPORTED'].includes(discoveryError.code)) {
          reason = discoveryError.message
        }
      }
    }
    if (!reason && preset?.harness === 'claude') {
      const supported = ClaudeFullAccessConfigurationSchema.safeParse(preset)
      if (!supported.success) reason = supported.error.issues[0]?.message
    }
    return { value: harness, label: reason ? `${harnessNames[harness]} · ${reason}` : harnessNames[harness],
      disabled: Boolean(reason), reason }
  })
  const harnessReason = harnessOptions.find((option) => option.value === configuration.harness)?.reason
  const currentSnapshot = JSON.stringify({ name, prompt, editor, graphqlTools, instructions, skills, placement, branchPrefix })
  const isDirty = additionalDirty || currentSnapshot !== initialSnapshot.current
  const nameError = fieldMessage(issues, 'name')
  const clearErrors = () => { setError(undefined); setIssues([]) }
  const updateConfiguration = (next: typeof configuration) => {
    setEditor((current) => ({ ...current, configuration: next }))
    clearErrors()
  }
  /** A new harness starts from its role default or preset; settings that only fit the old harness are dropped. */
  const switchHarness = (next: 'codex' | 'claude') => {
    if (next === configuration.harness || harnessOptions.find((option) => option.value === next)?.disabled) return
    const workflow = { approvalHandler: workflowApprovalHandler, designatedOrchestrator }
    const preset = harnessSwitchPreset(next, roleDefault, providerDefaults, workflow)
    setEditor((current) => switchAgentHarness(current, next, preset, workflow))
    clearErrors()
  }
  const save = () => {
    const previousSnapshot = initialSnapshot.current
    try {
      if (!name.trim()) throw new FieldValidationError([{ path: ['name'], message: 'Enter an agent name.' }])
      const nextConfiguration = (() => {
        try {
          const next = prepareHarnessEditor(editor)
          validateHarnessWorkflowCompatibility(next, workflowApprovalHandler, designatedOrchestrator)
          if (next.harness === 'codex' && workflowApprovalHandler) CodexSessionCompatibilitySchema.parse({ configuration: next, requiresResume: true })
          return next
        } catch (failure) {
          const harnessIssues = validationIssues(failure)
          if (harnessIssues.length) throw new FieldValidationError(harnessIssues.map((issue) => ({ ...issue,
            path: ['harness', ...(issue.path[0] === 'configuration' ? issue.path.slice(1) : issue.path)] })), { cause: failure })
          throw failure
        }
      })()
      if (placement) SavedNodePlacementSchema.parse(placement)
      const worktree = branchPrefix.trim() ? AgentWorktreeSettingsSchema.parse({ branchPrefix: branchPrefix.trim() }) : undefined
      initialSnapshot.current = currentSnapshot
      onSave({ ...agent, name: name.trim(), harness: nextConfiguration.harness, model: nextConfiguration.model,
        effort: legacyEffortForHarness(nextConfiguration), fastMode: nextConfiguration.harness === 'codex' ? nextConfiguration.serviceTier === 'priority' : undefined,
        harnessConfiguration: nextConfiguration,
        ...(graphqlTools.defaults ? { graphqlTools: graphqlTools.defaults } : {}),
        prompt: instructions.trim() ? { system: instructions.trim() } : {}, assignedSkills: skills,
      }, prompt.trim() || undefined, executionPolicy, graphqlTools.override, placement, worktree)
    } catch (failure) {
      initialSnapshot.current = previousSnapshot
      const nextIssues = validationIssues(failure)
      setIssues(nextIssues)
      // A problem with no field of its own is shown in words instead of an unexplained "marked fields" note.
      const unmarked = nextIssues.find((issue) => !markedField(issue.path))
      if (nextIssues.some((issue) => !mainField(issue.path))) setMoreOpen(true)
      setError(unmarked?.message ?? (nextIssues.length ? 'Review the marked fields before saving.' : errorMessage(failure, 'Agent settings are invalid.')))
    }
  }
  const leave = useUnsavedChanges({ scope: 'surface', label: 'agent settings', canResume, get dirty() { return additionalDirty || currentSnapshot !== initialSnapshot.current },
    error, save, discard: () => { initialSnapshot.current = currentSnapshot; onDiscardForm?.(); onClose() },
  })
  return {
    error, issues, moreOpen, setMoreOpen, root, setLocalPlacement, setLocalPrefix, name, prompt, editor, placement,
    branchPrefix, graphqlTools, instructions, skills, changeForm, setName, setPrompt, setGraphqlTools,
    setInstructions, setSkills, setEditor, providerDefaults, configuration, harnessOptions, harnessReason,
    isDirty, nameError, clearErrors, updateConfiguration, switchHarness, save, leave, role,
  }
}

const mainFields = new Set(['harness.model', 'harness.reasoningEffort', 'harness.effort', 'harness.sandbox', 'harness.serviceTier'])
const moreFields = new Set(['name', 'branchPrefix', 'harness.configDirectory', 'harness.authMode'])
const mainField = (path: readonly PropertyKey[]) => mainFields.has(path.map(String).join('.'))
/** Fields that show their own error next to the control. */
const markedField = (path: readonly PropertyKey[]) => {
  const key = path.map(String).join('.')
  return mainFields.has(key) || moreFields.has(key) || key.startsWith('harness.advanced.')
}

function EditableAgentSettingsForm(props: EditableAgentSettingsFormProps) {
  const { agent, onClose, onRemove, onFormChange, nodePlacement, nodeWorktree, workflowWorktree, workflowWorktreeLabel, worktreeDisabled,
    placementOptions, placementHidden, placementOptionsState, workspaceId, workflowApprovalHandler, embedded = false,
    additionalFields, mainFields, moreFields, unavailableComputers, placementNote } = props
  const form = useAgentSettingsForm(props)
  const { error, issues, moreOpen, setMoreOpen, root, setLocalPlacement, setLocalPrefix, name, prompt, editor, placement,
    branchPrefix, graphqlTools, instructions, skills, changeForm, setName, setPrompt, setGraphqlTools,
    setInstructions, setSkills, setEditor, providerDefaults, configuration, harnessOptions, harnessReason,
    isDirty, nameError, clearErrors, updateConfiguration, switchHarness, save, leave, role } = form
  const readOnly = configuration.harness === 'opencode' || configuration.sandbox === 'read-only'
  const harnessIssues = issuesAt(issues, ['harness'])
  const changeTools = (defaults: Parameters<typeof setGraphqlTools>[0]['defaults'], override: Parameters<typeof setGraphqlTools>[0]['override']) => {
    setGraphqlTools({ ...(defaults ? { defaults } : {}), ...(override ? { override } : {}) }); clearErrors()
  }
  const showPlacement = !placementHidden && Boolean(workspaceId || nodePlacement || placementOptions)
  return <div ref={root} className={`agent-settings-panel${embedded ? ' agent-settings-panel-embedded' : ''}`}>
    {embedded ? null : <header className="agent-settings-heading">
      <div className="agent-settings-title"><strong>Agent settings</strong></div>
      <div className="agent-settings-header-actions">
        <Button size="sm" variant="primary" className="agent-settings-save" aria-label="Save agent settings" disabled={!isDirty} onClick={save}>Save</Button>
        <IconButton size="sm" variant="ghost" label="Close agent settings" onClick={() => void leave(onClose)}><Icon name="close" size={15} /></IconButton>
      </div>
    </header>}
    <div className="agent-settings-general">
      <div className="agent-node-rows">
        <NodeRow label="Harness" note={harnessReason} tone="warning">
          <Select label="Harness" aria-label="Harness" className="agent-node-inline" value={configuration.harness}
            options={harnessOptions}
            onChange={(event) => switchHarness(AgentHarnessSchema.parse(event.target.value))} />
        </NodeRow>
        <AgentHarnessRows value={configuration} issues={harnessIssues} onChange={updateConfiguration} accountHost={placement?.hostRef} />
        {mainFields}
        <AgentMemoryRow role={role} defaults={graphqlTools.defaults} override={graphqlTools.override} readOnly={readOnly} onChange={changeTools} />
        {showPlacement ? <NodePlacementField value={placement} options={placementOptions ?? []} unavailableComputers={unavailableComputers}
          optionsState={placementOptionsState} note={placementNote} disabled={worktreeDisabled} inheritedWorktree={workflowWorktreeLabel}
          onChange={next => {
            if (onFormChange) changeForm({ placement: next })
            else setLocalPlacement(next)
            clearErrors()
          }} /> : null}
      </div>
      <details className="agent-settings-more" open={moreOpen} onToggle={(event) => setMoreOpen(event.currentTarget.open)}>
        <summary>More settings</summary>
        <div className="agent-settings-more-body">
          <TextField label="Name" aria-label="Name" value={name} error={nameError} onChange={(event) => { setName(event.target.value); clearErrors() }} />
          {configuration.harness !== 'opencode' ? <ProviderAccountSelect provider={configuration.harness} value={configuration.accountId} hostRef={placement?.hostRef}
            onChange={accountId => {
              const next = { ...configuration }
              if (accountId) next.accountId = accountId; else delete next.accountId
              updateConfiguration(next)
            }} /> : null}
          {configuration.harness === 'claude' && !configuration.accountId ? <>
            <TextField label="Claude profile folder" value={configuration.configDirectory} error={fieldMessage(harnessIssues, 'configDirectory')}
              onChange={(event) => updateConfiguration({ ...configuration, configDirectory: event.target.value })} />
            <Select label="Sign-in" value={configuration.authMode} error={fieldMessage(harnessIssues, 'authMode')}
              options={[{ value: 'subscription', label: 'Claude subscription' }, { value: 'api-key', label: 'API key' }]}
              onChange={(event) => updateConfiguration({ ...configuration, authMode: event.target.value as typeof configuration.authMode })} />
          </> : null}
          {additionalFields}
          {showPlacement ? <TextField label="Branch prefix" value={branchPrefix} placeholder={workflowWorktree?.branchPrefix ?? 'Automatic'}
            disabled={worktreeDisabled} error={fieldMessage(issues, 'branchPrefix')}
            onChange={event => {
              if (onFormChange) changeForm({ branchPrefix: event.target.value })
              else setLocalPrefix(event.target.value)
              clearErrors()
            }} /> : null}
          {workspaceId ? <AgentSkillsField workspaceId={workspaceId} value={skills} onChange={(next) => { setSkills(next); clearErrors() }} /> : null}
          <Textarea label="Instructions" className="agent-settings-prompt" rows={3} value={instructions}
            labelHint={<InfoHint label="Instructions">Given to this agent on every turn.</InfoHint>}
            onChange={(event) => { setInstructions(event.target.value); clearErrors() }} />
          <Textarea label="Initial prompt" aria-label="Initial prompt" className="agent-settings-prompt" rows={2} value={prompt}
            labelHint={<InfoHint label="Initial prompt">The task this node starts with.</InfoHint>}
            onChange={(event) => { setPrompt(event.target.value); clearErrors() }} />
          {moreFields}
          <GraphqlToolsFields role={role} defaults={graphqlTools.defaults} override={graphqlTools.override} hideMemory
            executionReadOnly={configuration.harness === 'codex' && configuration.sandbox === 'read-only'} readOnly={readOnly} onChange={changeTools} />
          <HarnessConfigurationFields editor={editor} issues={harnessIssues} onChange={(next) => { setEditor(next); clearErrors() }} allowHarnessChange={false} harnessDefaults={providerDefaults} workspaceId={workspaceId} routedApproval={Boolean(workflowApprovalHandler)} allowAutoReview={workflowApprovalHandler === 'orchestrator'} compact advancedOnly />
        </div>
      </details>
    </div>
    {error ? <Alert tone="danger" live title={error} /> : null}
    <footer className="agent-settings-footer">
      {onRemove ? <Button size="sm" variant="ghost" className="agent-settings-trash" aria-label={`Remove ${agent.name} from workflow`} onClick={() => void leave(onRemove)}>Remove</Button> : null}
      {embedded ? <Button size="sm" variant="ghost" className="agent-settings-cancel" onClick={() => { props.onDiscardForm?.(); onClose() }}>Cancel</Button> : null}
      {embedded ? <Button size="sm" variant="primary" className="agent-settings-save" aria-label="Apply agent settings to draft"
        disabled={!isDirty} onClick={save}>Apply</Button> : null}
    </footer>
  </div>
}

export function AgentSettingsForm(props: Parameters<typeof EditableAgentSettingsForm>[0]) {
  if (props.agent.harness === 'opencode' || props.agent.harnessConfiguration?.harness === 'opencode') {
    return <div className="harness-form-stack"><p role="status">{retiredHarnessLabel}</p>
      <p>{props.agent.name}</p><p>Model: {props.agent.harnessConfiguration?.model ?? props.agent.model ?? 'Not set'}</p>
      {props.agent.prompt?.system ? <p>{props.agent.prompt.system}</p> : null}
      {props.initialPrompt ? <p>{props.initialPrompt}</p> : null}
    </div>
  }
  return <EditableAgentSettingsForm {...props} />
}

import { MemoryBoardAccessField } from '../memory-boards'
import { InfoHint } from '../../shared/ui/InfoHint'
import {
  COLLABORATION_AGENT_TOOLS, FOREMAN_AGENT_TOOLS, ForemanAgentToolSchema, foremanRoleTools, effectiveForemanTools, memoryBoardTools, activeForemanTools, activeForemanToolOverride,
  type ForemanAgentTool, type ForemanToolOverride, type RecordedForemanToolOverride, type WorkflowAgentProductRole,
} from '@foreman-code/contracts'

import { Checkbox, SegmentedControl } from '../../shared/ui/nocturne'
import { useBoardAuthoring } from '../board-core'
import { useCollaborationUISlots } from '../../shared/ui/collaborationSlots'

type NodeChoice = 'default' | 'on' | 'off'

/** An empty override is stored as none, so the node follows the Agent default. */
function normalizeToolOverride(override: ForemanToolOverride | undefined): ForemanToolOverride | undefined {
  return override && (override.add.length || override.remove.length) ? override : undefined
}

/** The Agent's default Foreman Code MCP tools, and this workflow node's change to them. */
export function ForemanToolsFields({ role, defaults: recordedDefaults, override: recordedOverride, onChange, executionReadOnly = false, readOnly = false, hideMemory = false }: {
  /** Workflow Agent roles only; Operator tools are never enabled per Agent. */
  role: WorkflowAgentProductRole
  defaults: readonly string[] | undefined
  override: RecordedForemanToolOverride | undefined
  executionReadOnly?: boolean
  readOnly?: boolean
  /** Memory access is edited elsewhere in the same form. */
  hideMemory?: boolean
  /** Missing defaults retain the legacy enabled set until explicitly edited. */
  onChange(defaults: ForemanAgentTool[] | undefined, override: ForemanToolOverride | undefined): void
}) {
  const defaults = recordedDefaults && activeForemanTools(recordedDefaults), override = activeForemanToolOverride(recordedOverride)
  const sharedFields = useCollaborationUISlots()
  const fields = useBoardAuthoring()?.collaborationFields ?? sharedFields
  const memoryTools: ForemanAgentTool[] = memoryBoardTools('write')
  const browserTools = fields?.nodeBrowser ? Object.keys(COLLABORATION_AGENT_TOOLS).filter(name => name.startsWith('browser_')) as ForemanAgentTool[] : []
  const implemented: ForemanAgentTool[] = [...memoryTools, ...browserTools]
  const tools = foremanRoleTools(role, implemented)
  const agentDefault = effectiveForemanTools(role, defaults, undefined, false, implemented)
  const choice = (tool: ForemanAgentTool): NodeChoice => override?.add.includes(tool) ? 'on' : override?.remove.includes(tool) ? 'off' : 'default'
  const setDefault = (tool: ForemanAgentTool, enabled: boolean) => {
    // Editing one visible legacy tool must retain configured collaboration tools
    // even while their feature-owned field/handler is not mounted.
    const selected = new Set(defaults ?? agentDefault)
    if (enabled) selected.add(tool); else selected.delete(tool)
    const next = ForemanAgentToolSchema.options.filter(item => selected.has(item))
    // A node change that now matches the default is no longer a change.
    const add = (override?.add ?? []).filter((item) => !next.includes(item))
    const remove = (override?.remove ?? []).filter((item) => next.includes(item) || item.startsWith('browser_'))
    onChange(next, normalizeToolOverride({ add, remove }))
  }
  const setChoice = (tool: ForemanAgentTool, value: NodeChoice) => {
    const add = (override?.add ?? []).filter((item) => item !== tool)
    const remove = (override?.remove ?? []).filter((item) => item !== tool)
    if (value === 'on' && !agentDefault.includes(tool)) add.push(tool)
    if (value === 'off' && (agentDefault.includes(tool) || tool.startsWith('browser_'))) remove.push(tool)
    // A node-only change never rewrites the Agent's default.
    onChange(defaults ? [...defaults] : undefined, normalizeToolOverride({ add, remove }))
  }
  return <fieldset className="agent-graphql-tools" aria-label="Foreman Code MCP tools">
    <legend>Tools<InfoHint label="Tools">Bug reporting is always available. For other tools, the Agent default applies in every workflow. This workflow can turn a tool on or off for this node only.</InfoHint></legend>
    {hideMemory ? null : fields?.memoryAccess ? fields.memoryAccess({ role, defaults, override, executionReadOnly: readOnly || executionReadOnly, onChange }) : <MemoryBoardAccessField agentDefaultTools={agentDefault} readOnly={readOnly || executionReadOnly}
      value={override?.add.some(tool => memoryTools.includes(tool)) || override?.remove.some(tool => memoryTools.includes(tool))
        ? effectiveForemanTools(role, defaults, override, false, memoryTools) : undefined}
      onChange={selected => {
        const next = (selected ?? agentDefault).map(tool => ForemanAgentToolSchema.parse(tool))
        const add = (override?.add ?? []).filter(tool => !memoryTools.includes(tool))
        const remove = (override?.remove ?? []).filter(tool => !memoryTools.includes(tool))
        for (const tool of memoryTools) {
          if (next.includes(tool) && !agentDefault.includes(tool)) add.push(tool)
          if (!next.includes(tool) && agentDefault.includes(tool)) remove.push(tool)
        }
        onChange(defaults ? [...defaults] : undefined, normalizeToolOverride({ add, remove }))
      }} />}
    <div className="agent-graphql-tools-list">
      {tools.filter(tool => !memoryTools.includes(tool)).map((tool) => {
        const definition = FOREMAN_AGENT_TOOLS[tool]
        if (tool === 'bug_report') {
          return <div key={tool} className="agent-graphql-tool">
            <div className="agent-graphql-tool-name">
              <strong>{definition.label}<InfoHint label={definition.label}>{definition.description}</InfoHint></strong>
            </div>
            <span>Always available</span>
          </div>
        }
        const inDefault = agentDefault.includes(tool)
        return <div key={tool} className="agent-graphql-tool" data-changed={choice(tool) !== 'default' || undefined}>
          <div className="agent-graphql-tool-name">
            <strong>{definition.label}<InfoHint label={definition.label}>{definition.description}</InfoHint></strong>
          </div>
          <Checkbox label="Agent default" aria-label={`${definition.label}: Agent default`} checked={inDefault}
            onChange={(event) => setDefault(tool, event.target.checked)} />
          <SegmentedControl label={`${definition.label}: this workflow`} value={choice(tool)} onValueChange={(value) => setChoice(tool, value as NodeChoice)}
            options={[{ value: 'default', label: tool.startsWith('browser_') ? 'Default' : `Default (${inDefault ? 'on' : 'off'})` }, { value: 'on', label: 'On', disabled: inDefault }, { value: 'off', label: 'Off', disabled: !inDefault && !tool.startsWith('browser_') }]} />
        </div>
      })}
    </div>
  </fieldset>
}
